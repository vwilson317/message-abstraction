import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/db';
import { applyGroupChange, dateIsOn, DEFAULT_GROUP_ALERTS, type GroupAlerts, type GroupChange } from './groups';
import type { MediaStore } from './media';
import type {
  Connector,
  ConnectorContext,
  ConversationInput,
  MessageInput,
  MessagePatch,
  UpsertOptions,
} from './connector';
import type {
  Attachment,
  Conversation,
  ConnectorStatus,
  DeliveryStatus,
  HubEvent,
  Message,
  Participant,
  Settings,
  SourceKind,
} from './types';

/** Batches larger than this emit one `messages.bulk` event instead of one event per message. */
const BULK_EVENT_THRESHOLD = 25;

const STATUS_RANK: Record<DeliveryStatus, number> = { failed: -1, pending: 0, sent: 1, delivered: 2, read: 3 };

export class HubError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message);
  }
}

/**
 * The one place that turns connector and importer output into stored,
 * namespaced conversations and messages, and tells listeners about it.
 */
export class Hub {
  private readonly events = new EventEmitter();
  private readonly connectors = new Map<string, Connector>();
  private readonly statuses = new Map<string, ConnectorStatus>();
  /** Connectors started and not stopped since. Their displayed state can read "stopped" while idle. */
  private readonly running = new Set<string>();

  constructor(
    readonly store: Store,
    readonly media: MediaStore,
    private readonly dataDir: string,
    private readonly log: ConnectorContext['log'] = () => {},
  ) {
    this.events.setMaxListeners(0);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  private emit(event: HubEvent): void {
    this.events.emit('event', event);
  }

  // ── Connectors ────────────────────────────────────────────────────────────

  register(connector: Connector): void {
    this.connectors.set(connector.id, connector);
    this.statuses.set(connector.id, {
      id: connector.id,
      platform: connector.platform,
      label: connector.label,
      state: 'stopped',
    });
  }

  connectorStatuses(): ConnectorStatus[] {
    return [...this.statuses.values()];
  }

  /** Start every connector whose app looks present on this machine, side by side. */
  async autoStart(): Promise<void> {
    await Promise.all(
      [...this.connectors.values()].map(async (connector) => {
        try {
          if (await connector.shouldAutoStart(this.dirFor(connector))) await this.startConnector(connector.id);
        } catch (err) {
          this.log('error', `[${connector.id}] Could not start`, err);
        }
      }),
    );
  }

  async startConnector(id: string): Promise<void> {
    const connector = this.requireConnector(id);
    const state = this.statuses.get(id)?.state;
    // A failed start (error, needs setup) can be retried; a running one is left alone.
    if (this.running.has(id) && state !== 'error' && state !== 'needs_setup') return;
    this.running.add(id);
    try {
      await connector.start(this.contextFor(connector));
    } catch (err) {
      this.running.delete(id);
      throw err;
    }
  }

  async stopConnector(id: string): Promise<void> {
    await this.requireConnector(id).stop();
    this.running.delete(id);
    this.updateStatus(id, { state: 'stopped' });
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.connectors.values()].map((c) => c.stop()));
  }

  /** Hand a browser-extension capture to the source it belongs to. */
  receive(id: string, body: unknown): { conversationId: string; added: number; skipped?: string } {
    const connector = this.requireConnector(id);
    if (!connector.receive) throw new HubError(`${connector.label} doesn't accept captures`, 404);
    return connector.receive(body);
  }

  heartbeat(id: string): void {
    const connector = this.requireConnector(id);
    if (!connector.heartbeat) throw new HubError(`${connector.label} doesn't take heartbeats`, 404);
    connector.heartbeat();
  }

  /** A media file a connector serves from its app's own storage, if it has one. */
  connectorMediaFile(id: string, ref: string): string | null {
    return this.requireConnector(id).mediaFile?.(ref) ?? null;
  }

  private requireConnector(id: string): Connector {
    const connector = this.connectors.get(id);
    if (!connector) throw new HubError(`Unknown connector "${id}"`, 404);
    return connector;
  }

  private updateStatus(id: string, patch: Partial<ConnectorStatus>): void {
    const current = this.statuses.get(id);
    if (!current) return;
    // Sources report the same status on every poll; only changes are news.
    if ((patch.state ?? current.state) === current.state && patch.detail === current.detail) return;
    // `detail` only makes sense for the state it arrived with.
    const next: ConnectorStatus = {
      id: current.id,
      platform: current.platform,
      label: current.label,
      state: patch.state ?? current.state,
      ...(patch.detail !== undefined && { detail: patch.detail }),
    };
    this.statuses.set(id, next);
    this.emit({ type: 'connector.status', status: next });
  }

  private dirFor(connector: Connector): string {
    return join(this.dataDir, 'connectors', connector.id);
  }

  private contextFor(connector: Connector): ConnectorContext {
    const dataDir = this.dirFor(connector);
    mkdirSync(dataDir, { recursive: true });
    return {
      dataDir,
      log: (level, message, extra) => this.log(level, `[${connector.id}] ${message}`, extra),
      setStatus: (status) => this.updateStatus(connector.id, status),
      saveMedia: (data, hint) => this.media.save(data, hint),
      upsertConversation: (input) => this.upsertConversation(connector.id, 'live', input),
      upsertMessages: (inputs, options) => this.upsertMessages(connector.id, 'live', inputs, options),
      patchMessage: (patch) => this.patchMessage(connector.id, patch),
      retireConversation: (from, into) => this.retireConversation(connector.id, from, into),
    };
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  upsertConversation(sourceId: string, sourceKind: SourceKind, input: ConversationInput): Conversation {
    const conversation = this.mergeConversation(sourceId, sourceKind, input);
    this.store.saveConversation(conversation);
    this.emit({ type: 'conversation.upserted', conversation });
    return conversation;
  }

  upsertMessages(sourceId: string, sourceKind: SourceKind, inputs: MessageInput[], options: UpsertOptions): void {
    if (inputs.length === 0) return;
    const touched = new Map<string, Conversation>();
    const changed: Message[] = [];

    this.store.transaction(() => {
      for (const input of inputs) {
        const conversationId = `${sourceId}:${input.conversationNativeId}`;
        let conversation = touched.get(conversationId) ?? this.store.getConversation(conversationId);
        if (!conversation) {
          conversation = this.mergeConversation(sourceId, sourceKind, {
            platform: this.platformOf(sourceId),
            nativeId: input.conversationNativeId,
          });
          // Messages reference their conversation, so it has to exist first.
          this.store.saveConversation(conversation);
        }
        const id = `${conversationId}:${input.nativeId}`;
        const existing = this.store.getMessage(id);
        if (existing && options.onlyIfNew) continue;
        const message = existing
          ? mergeMessage(existing, input, options.authoritative ?? false)
          : newMessage(id, conversationId, input);
        // Mirrors re-read the same rows often; unchanged rows cost no write and no event.
        if (existing && sameMessage(existing, message)) continue;
        this.store.saveMessage(message);
        changed.push(message);

        if (!existing) {
          conversation = { ...conversation, messageCount: conversation.messageCount + 1 };
          if (options.countUnread && !message.fromSelf && message.kind !== 'system') {
            conversation = { ...conversation, unreadCount: conversation.unreadCount + 1 };
          }
        }
        if (conversation.lastMessageAt === null || message.timestamp >= conversation.lastMessageAt) {
          conversation = {
            ...conversation,
            lastMessageAt: message.timestamp,
            lastMessagePreview: preview(message, conversation.isGroup),
          };
        }
        touched.set(conversationId, conversation);
      }
      for (const conversation of touched.values()) this.store.saveConversation(conversation);
    });

    for (const conversation of touched.values()) this.emit({ type: 'conversation.upserted', conversation });
    if (changed.length > BULK_EVENT_THRESHOLD) {
      for (const conversationId of touched.keys()) this.emit({ type: 'messages.bulk', conversationId });
    } else {
      for (const message of changed) this.emit({ type: 'message.upserted', message });
    }
  }

  patchMessage(sourceId: string, patch: MessagePatch): void {
    const id = `${sourceId}:${patch.conversationNativeId}:${patch.nativeId}`;
    const existing = this.store.getMessage(id);
    if (!existing) return;
    const message: Message = { ...existing };
    if (patch.text !== undefined) message.text = patch.text;
    if (patch.edited) message.edited = true;
    if (patch.deleted) {
      message.deleted = true;
      message.text = null;
      message.attachments = [];
    }
    if (patch.status) message.status = higherStatus(existing.status, patch.status);
    if (patch.attachments && !message.deleted) message.attachments = patch.attachments;
    if (patch.reaction) {
      const others = existing.reactions.filter((r) => r.senderId !== patch.reaction!.senderId);
      message.reactions = patch.reaction.emoji ? [...others, patch.reaction] : others;
    }
    this.store.saveMessage(message);
    this.emit({ type: 'message.upserted', message });
    this.refreshPreviewIfLatest(message);
  }

  /** See ConnectorContext.retireConversation. */
  retireConversation(sourceId: string, fromNativeId: string, intoNativeId: string): void {
    const from = this.store.getConversation(`${sourceId}:${fromNativeId}`);
    if (!from || fromNativeId === intoNativeId) return;
    const intoId = `${sourceId}:${intoNativeId}`;
    let into = this.store.getConversation(intoId) ?? {
      ...from,
      id: intoId,
      nativeId: intoNativeId,
      group: 'close' as const,
      dateAt: null,
      groupSetAt: null,
      messageCount: 0,
      lastMessageAt: null,
      lastMessagePreview: null,
    };
    // Whichever side was placed in a group more recently decides.
    if ((from.groupSetAt ?? -1) > (into.groupSetAt ?? -1)) {
      into = { ...into, group: from.group, dateAt: from.dateAt, groupSetAt: from.groupSetAt };
    }
    this.store.transaction(() => {
      this.store.saveConversation(into);
      for (const message of this.store.allMessages(from.id)) {
        const id = `${intoId}:${message.nativeId}`;
        if (!this.store.getMessage(id)) this.store.saveMessage({ ...message, id, conversationId: intoId });
      }
      this.store.deleteConversation(from.id);
      const latest = this.store.latestMessage(intoId);
      into = {
        ...into,
        messageCount: this.store.countMessages(intoId),
        lastMessageAt: latest?.timestamp ?? null,
        lastMessagePreview: latest ? preview(latest, into.isGroup) : null,
      };
      this.store.saveConversation(into);
    });
    this.emit({ type: 'conversation.deleted', conversationId: from.id });
    this.emit({ type: 'conversation.upserted', conversation: into });
    this.emit({ type: 'messages.bulk', conversationId: intoId });
  }

  markRead(conversationId: string): Conversation {
    const conversation = this.requireConversation(conversationId);
    if (conversation.unreadCount === 0) return conversation;
    const next = { ...conversation, unreadCount: 0 };
    this.store.saveConversation(next);
    this.emit({ type: 'conversation.upserted', conversation: next });
    return next;
  }

  /** Move a conversation between groups, or schedule a date (see core/groups.ts). */
  setGroup(conversationId: string, change: GroupChange, now = Date.now()): Conversation {
    const conversation = this.requireConversation(conversationId);
    if (change.group === 'dates' && !(Number.isFinite(change.dateAt) && dateIsOn({ dateAt: change.dateAt }, now))) {
      throw new HubError('That date has already passed');
    }
    const next: Conversation = { ...conversation, ...applyGroupChange(conversation, change, now) };
    this.store.saveConversation(next);
    this.emit({ type: 'conversation.upserted', conversation: next });
    return next;
  }

  settings(): Settings {
    return { groupAlerts: { ...DEFAULT_GROUP_ALERTS, ...this.store.getSetting<Partial<GroupAlerts>>('groupAlerts') } };
  }

  updateSettings(patch: { groupAlerts?: Partial<GroupAlerts> }): Settings {
    if (patch.groupAlerts) {
      const current = this.settings().groupAlerts;
      for (const [key, value] of Object.entries(patch.groupAlerts)) {
        if (!(key in current) || typeof value !== 'boolean') throw new HubError(`Unknown alert setting "${key}"`);
      }
      this.store.setSetting('groupAlerts', { ...current, ...patch.groupAlerts });
    }
    const settings = this.settings();
    this.emit({ type: 'settings.updated', settings });
    return settings;
  }

  /** For imports, where the export doesn't say which participant is the account owner. */
  setSelf(conversationId: string, participantId: string | null): Conversation {
    const conversation = this.requireConversation(conversationId);
    if (participantId !== null && !conversation.participants.some((p) => p.id === participantId)) {
      throw new HubError(`"${participantId}" is not a participant in this conversation`);
    }
    const next: Conversation = {
      ...conversation,
      participants: conversation.participants.map((p) => ({ ...p, isSelf: p.id === participantId })),
    };
    this.store.transaction(() => {
      this.store.saveConversation(next);
      this.store.setSelfSender(conversationId, participantId);
    });
    this.emit({ type: 'conversation.upserted', conversation: next });
    this.emit({ type: 'messages.bulk', conversationId });
    return next;
  }

  deleteConversation(conversationId: string): void {
    if (!this.store.deleteConversation(conversationId)) {
      throw new HubError('Conversation not found', 404);
    }
    this.emit({ type: 'conversation.deleted', conversationId });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  requireConversation(id: string): Conversation {
    const conversation = this.store.getConversation(id);
    if (!conversation) throw new HubError('Conversation not found', 404);
    return conversation;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private mergeConversation(sourceId: string, sourceKind: SourceKind, input: ConversationInput): Conversation {
    const id = `${sourceId}:${input.nativeId}`;
    const existing = this.store.getConversation(id);
    if (!existing) {
      return {
        id,
        sourceId,
        sourceKind,
        platform: input.platform,
        nativeId: input.nativeId,
        title: input.title || input.nativeId,
        isGroup: input.isGroup ?? false,
        participants: input.participants ?? [],
        lastMessageAt: null,
        lastMessagePreview: null,
        unreadCount: input.unreadCount ?? 0,
        messageCount: 0,
        group: 'close',
        dateAt: null,
        groupSetAt: null,
      };
    }
    return {
      ...existing,
      title: input.title || existing.title,
      isGroup: input.isGroup ?? existing.isGroup,
      participants: mergeParticipants(existing.participants, input.participants ?? []),
      unreadCount: input.unreadCount ?? existing.unreadCount,
    };
  }

  private platformOf(sourceId: string): Conversation['platform'] {
    const connector = this.connectors.get(sourceId);
    if (connector) return connector.platform;
    if (sourceId.endsWith('instagram')) return 'instagram';
    return 'whatsapp';
  }

  private refreshPreviewIfLatest(message: Message): void {
    const conversation = this.store.getConversation(message.conversationId);
    if (!conversation || this.store.latestMessage(conversation.id)?.id !== message.id) return;
    const next = { ...conversation, lastMessagePreview: preview(message, conversation.isGroup) };
    this.store.saveConversation(next);
    this.emit({ type: 'conversation.upserted', conversation: next });
  }
}

function mergeParticipants(current: Participant[], incoming: Participant[]): Participant[] {
  const byId = new Map(current.map((p) => [p.id, p]));
  for (const p of incoming) {
    const known = byId.get(p.id);
    byId.set(p.id, known ? { ...known, name: p.name || known.name, isSelf: known.isSelf || p.isSelf } : p);
  }
  return [...byId.values()];
}

function newMessage(id: string, conversationId: string, input: MessageInput): Message {
  return {
    id,
    conversationId,
    nativeId: input.nativeId,
    senderId: input.senderId,
    senderName: input.senderName,
    fromSelf: input.fromSelf,
    timestamp: input.timestamp,
    kind: input.kind,
    text: input.text,
    attachments: input.attachments ?? [],
    reactions: input.reactions ?? [],
    replyToNativeId: input.replyToNativeId ?? null,
    status: input.status ?? null,
    edited: input.edited ?? false,
    deleted: input.deleted ?? false,
  };
}

/**
 * A re-delivered message (history sync, re-import) must not undo edits,
 * deletes or receipts. An authoritative source shows the message as it is
 * now, so its text wins, and a change to it is an edit.
 */
function mergeMessage(existing: Message, input: MessageInput, authoritative: boolean): Message {
  const deleted = existing.deleted || (input.deleted ?? false);
  const changed = existing.text !== null && input.text !== null && input.text !== existing.text;
  const takeText = authoritative || input.edited || !existing.edited;
  return {
    ...existing,
    senderId: input.senderId || existing.senderId,
    senderName: input.senderName || existing.senderName,
    kind: existing.deleted ? existing.kind : input.kind,
    // Otherwise an edited input carries the current text, and a stale copy can't undo an edit.
    text: deleted ? null : takeText ? input.text : existing.text,
    attachments: deleted ? [] : mergeAttachments(existing.attachments, input.attachments ?? []),
    // A source that reports reactions reports all of them, so an empty list clears them.
    reactions: input.reactions ?? existing.reactions,
    replyToNativeId: input.replyToNativeId ?? existing.replyToNativeId,
    status: input.status ? higherStatus(existing.status, input.status) : existing.status,
    edited: existing.edited || (input.edited ?? false) || (authoritative && changed && !deleted),
    deleted,
  };
}

function sameMessage(a: Message, b: Message): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeAttachments(current: Attachment[], incoming: Attachment[]): Attachment[] {
  if (incoming.length === 0) return current;
  // Prefer whichever side has resolved media URLs.
  return incoming.map((a, i) => (a.url ? a : { ...a, url: current[i]?.url }));
}

function higherStatus(current: DeliveryStatus | null, next: DeliveryStatus): DeliveryStatus {
  if (!current || next === 'failed') return next;
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

const ATTACHMENT_LABELS: Record<Attachment['type'], string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  audio: '🎤 Audio',
  sticker: '💟 Sticker',
  document: '📄 Document',
  location: '📍 Location',
  contact: '👤 Contact',
  link: '🔗 Link',
  other: '📎 Attachment',
};

export function preview(message: Message, isGroup: boolean): string {
  let body: string;
  if (message.deleted) body = 'Message deleted';
  else if (message.text) body = message.text;
  else if (message.attachments[0]) body = ATTACHMENT_LABELS[message.attachments[0].type];
  else body = '';
  body = body.replace(/\s+/g, ' ').slice(0, 140);
  if (message.kind === 'system') return body;
  if (message.fromSelf) return `You: ${body}`;
  return isGroup ? `${message.senderName}: ${body}` : body;
}
