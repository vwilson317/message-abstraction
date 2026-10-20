import type { Connector, ConnectorContext, MessageInput } from '../../core/connector';
import { HubError } from '../../core/hub';
import type { AttachmentType, Platform } from '../../core/types';
import { alignCapture, type StoredItem } from './align';

/** Stored messages of a conversation, oldest first: what a capture is lined up against. */
export type StoredTail = (conversationId: string) => StoredItem[];

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
  /** The window reaches the newest message in the thread. */
  atBottom?: boolean;
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
  const { thread, messages, atBottom } = body as Record<string, unknown>;
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
    ...(typeof atBottom === 'boolean' && { atBottom }),
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

export interface CaptureResult {
  conversationId: string;
  added: number;
  /** Why nothing was stored, when the window couldn't be placed. */
  skipped?: string;
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
    /** Stored messages to align a capture against. */
    private readonly storedTail: StoredTail,
  ) {}

  async shouldAutoStart(): Promise<boolean> {
    return true;
  }

  async start(ctx: ConnectorContext): Promise<void> {
    clearInterval(this.timer);
    this.ctx = ctx;
    this.refreshStatus();
    this.timer = setInterval(() => this.refreshStatus(), 15_000);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    // Stopped means stopped: captures are refused until Start.
    this.ctx = undefined;
  }

  receive(body: unknown): CaptureResult {
    return this.ingest(parseCapture(body));
  }

  /** The extension checks in while a matching tab is open. */
  heartbeat(): void {
    if (!this.ctx) throw new HubError(`${this.label} is stopped`, 503);
    this.lastSeen = Date.now();
    this.refreshStatus();
  }

  ingest(capture: Capture): CaptureResult {
    const ctx = this.ctx;
    if (!ctx) throw new HubError(`${this.label} is stopped`, 503);
    this.heartbeat();
    const { thread } = capture;
    const conversationId = `${this.id}:${thread.id}`;
    // One window can't prove a thread is 1:1 (one speaker may just be all that's
    // on screen), so a thread seen as a group stays one.
    let conversation = ctx.upsertConversation({
      platform: this.platform,
      nativeId: thread.id,
      title: thread.title,
      ...(thread.isGroup && { isGroup: true }),
    });
    const isGroup = conversation.isGroup;
    // Incoming messages use the sender's name as their id, and yours use "me".
    const others = thread.participants ?? (isGroup ? [] : [thread.title]);
    const known = new Set(conversation.participants.map((p) => p.id));
    if (!known.has('me') || others.some((name) => !known.has(name))) {
      conversation = ctx.upsertConversation({
        platform: this.platform,
        nativeId: thread.id,
        participants: [
          ...others.map((name) => ({ id: name, name, isSelf: false })),
          { id: 'me', name: 'You', isSelf: true },
        ],
      });
    }

    const aligned = alignCapture(capture.messages, this.storedTail(conversationId), {
      ...(capture.atBottom !== undefined && { atBottom: capture.atBottom }),
    });
    if ('skipped' in aligned) return { conversationId, added: 0, skipped: aligned.skipped };
    const inputs: MessageInput[] = aligned.messages.map(({ message, nativeId, timestamp, isNew, edited }) => {
      // In a group, a page that named the sender after the thread didn't know who it was.
      const name = isGroup && message.senderName === thread.title ? '' : message.senderName;
      return {
        conversationNativeId: thread.id,
        nativeId,
        // An empty sender on a known message keeps the one stored earlier.
        senderId: message.fromSelf ? 'me' : name || (isNew ? 'unknown' : ''),
        senderName: message.fromSelf ? 'You' : name || (isNew ? 'Unknown' : ''),
        fromSelf: message.fromSelf,
        timestamp,
        kind: message.attachments?.length && !message.text ? 'media' : 'text',
        text: message.deleted ? null : message.text,
        attachments: message.deleted ? [] : (message.attachments ?? []),
        // A bubble without visible reactions may just not be showing them; keep what's stored.
        reactions: message.reactions?.length
          ? message.reactions.map((r) => ({ emoji: r.emoji, senderId: r.senderName, senderName: r.senderName }))
          : undefined,
        ...(edited && { edited: true }),
        deleted: message.deleted ?? false,
      };
    });
    ctx.upsertMessages(inputs, { countUnread: false });
    return { conversationId, added: aligned.messages.filter((a) => a.isNew).length };
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
