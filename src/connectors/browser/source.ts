import type { Connector, ConnectorContext, MessageInput } from '../../core/connector';
import { HubError } from '../../core/hub';
import type { AttachmentType, Platform } from '../../core/types';
import { alignCapture, type StoredItem } from './align';

export type StoredTail = (conversationId: string, range: { from: number; to: number } | null) => StoredItem[];

/** How far around a capture's own timestamps to look for already-stored messages. */
const RANGE_MARGIN_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * A conversation as the browser extension saw it on screen. Pages like
 * instagram.com render a window of the thread at a time, so each capture is
 * a slice, not the whole history.
 */
export interface Capture {
  thread: {
    id: string;
    title: string;
    isGroup?: boolean;
    participants?: string[];
  };
  /** Display order, oldest first. */
  messages: CapturedMessage[];
}

export interface CapturedMessage {
  /** A stable id from the page, when it exposes one. */
  id?: string;
  senderName: string;
  fromSelf: boolean;
  text: string | null;
  /** Exact or inferred (from the page's time separators) epoch milliseconds. */
  timestamp?: number;
  attachments?: { type: AttachmentType; url?: string; name?: string }[];
  reactions?: { emoji: string; senderName: string }[];
  /** The page marked the message as unsent/deleted. */
  deleted?: boolean;
}

const ATTACHMENT_TYPES = new Set<AttachmentType>([
  'image',
  'video',
  'audio',
  'sticker',
  'document',
  'location',
  'contact',
  'link',
  'other',
]);

/** Treat the extension as gone if it hasn't checked in for this long. */
const STALE_MS = 90_000;
const MAX_MESSAGES_PER_CAPTURE = 2000;

function fail(message: string): never {
  throw new HubError(`Invalid capture: ${message}`);
}

function text(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  return value.slice(0, max);
}

/** Validate untrusted JSON from the extension into a Capture. */
export function parseCapture(body: unknown): Capture {
  if (!body || typeof body !== 'object') fail('expected an object');
  const { thread, messages } = body as Record<string, unknown>;
  if (!thread || typeof thread !== 'object') fail('missing thread');
  const t = thread as Record<string, unknown>;
  const id = text(t.id, 'thread.id', 200);
  if (!/^[\w.-]+$/.test(id)) fail('thread.id has unexpected characters');
  if (!Array.isArray(messages)) fail('messages must be an array');
  if (messages.length > MAX_MESSAGES_PER_CAPTURE) fail('too many messages');
  return {
    thread: {
      id,
      title: text(t.title, 'thread.title', 300) || id,
      ...(typeof t.isGroup === 'boolean' && { isGroup: t.isGroup }),
      ...(Array.isArray(t.participants) && {
        participants: t.participants.filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 200)),
      }),
    },
    messages: messages.map((raw, i): CapturedMessage => {
      if (!raw || typeof raw !== 'object') fail(`messages[${i}] must be an object`);
      const m = raw as Record<string, unknown>;
      const attachments = Array.isArray(m.attachments)
        ? m.attachments
            .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
            .filter((a) => ATTACHMENT_TYPES.has(a.type as AttachmentType))
            .map((a) => ({
              type: a.type as AttachmentType,
              ...(typeof a.url === 'string' && /^https:\/\//.test(a.url) && { url: a.url.slice(0, 2000) }),
              ...(typeof a.name === 'string' && { name: a.name.slice(0, 300) }),
            }))
        : [];
      const reactions = Array.isArray(m.reactions)
        ? m.reactions
            .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
            .filter((r) => typeof r.emoji === 'string' && typeof r.senderName === 'string')
            .map((r) => ({ emoji: String(r.emoji).slice(0, 16), senderName: String(r.senderName).slice(0, 200) }))
        : [];
      return {
        ...(typeof m.id === 'string' && m.id && { id: m.id.slice(0, 200) }),
        senderName: typeof m.senderName === 'string' ? m.senderName.slice(0, 200) : '',
        fromSelf: m.fromSelf === true,
        text: m.text === null || m.text === undefined ? null : text(m.text, `messages[${i}].text`),
        ...(typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) && { timestamp: m.timestamp }),
        attachments,
        reactions,
        ...(m.deleted === true && { deleted: true }),
      };
    }),
  };
}

/**
 * Receives what the browser extension reads from a messaging site open in a
 * tab. The extension pushes; this side keeps status and turns captures into
 * stored messages. Nothing here talks to the messaging service.
 */
export class BrowserSource implements Connector {
  private ctx?: ConnectorContext;
  private lastSeen = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    readonly id: string,
    readonly platform: Platform,
    readonly label: string,
    private readonly setupHint: string,
    /** Stored messages to align a capture against: around its timestamps, or the newest. */
    private readonly storedTail: StoredTail,
  ) {}

  async shouldAutoStart(): Promise<boolean> {
    return true;
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
    this.refreshStatus();
    this.timer = setInterval(() => this.refreshStatus(), 15_000);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  receive(body: unknown): { conversationId: string; added: number } {
    return this.ingest(parseCapture(body));
  }

  /** The extension checks in while a matching tab is open. */
  heartbeat(): void {
    this.lastSeen = Date.now();
    this.refreshStatus();
  }

  ingest(capture: Capture): { conversationId: string; added: number } {
    const ctx = this.ctx;
    if (!ctx) throw new HubError(`${this.label} is stopped`, 503);
    this.heartbeat();
    const { thread } = capture;
    const conversationId = `${this.id}:${thread.id}`;
    // Incoming messages use the sender's name as their id, and yours use "me".
    const others = thread.participants ?? (thread.isGroup ? [] : [thread.title]);
    ctx.upsertConversation({
      platform: this.platform,
      nativeId: thread.id,
      title: thread.title,
      ...(thread.isGroup !== undefined && { isGroup: thread.isGroup }),
      participants: [
        ...others.map((name) => ({ id: name, name, isSelf: false })),
        { id: 'me', name: 'You', isSelf: true },
      ],
    });

    const stamps = capture.messages.map((m) => m.timestamp).filter((t): t is number => t !== undefined);
    const range = stamps.length
      ? { from: Math.min(...stamps) - RANGE_MARGIN_MS, to: Math.max(...stamps) + RANGE_MARGIN_MS }
      : null;
    const aligned = alignCapture(capture.messages, this.storedTail(conversationId, range));
    const inputs: MessageInput[] = aligned.map(({ message, nativeId, timestamp, isNew }) => ({
      conversationNativeId: thread.id,
      nativeId,
      senderId: message.fromSelf ? 'me' : message.senderName || 'unknown',
      // An empty name on a known message keeps the name stored earlier.
      senderName: message.fromSelf ? 'You' : message.senderName || (isNew ? 'Unknown' : ''),
      fromSelf: message.fromSelf,
      timestamp,
      kind: message.attachments?.length && !message.text ? 'media' : 'text',
      text: message.deleted ? null : message.text,
      attachments: message.deleted ? [] : (message.attachments ?? []),
      reactions: (message.reactions ?? []).map((r) => ({
        emoji: r.emoji,
        senderId: r.senderName,
        senderName: r.senderName,
      })),
      deleted: message.deleted ?? false,
    }));
    ctx.upsertMessages(inputs, { countUnread: false });
    return { conversationId, added: aligned.filter((a) => a.isNew).length };
  }

  private refreshStatus(): void {
    if (this.lastSeen === 0) {
      this.ctx?.setStatus({ state: 'needs_setup', detail: this.setupHint });
    } else if (Date.now() - this.lastSeen < STALE_MS) {
      this.ctx?.setStatus({ state: 'connected', detail: 'Reading the conversation open in Chrome' });
    } else {
      // The extension was here earlier; no tab is open right now, which is fine.
      this.ctx?.setStatus({ state: 'stopped', detail: 'Idle until a conversation is open in Chrome' });
    }
  }
}
