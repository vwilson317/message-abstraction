import type {
  Attachment,
  ConnectorStatus,
  DeliveryStatus,
  MessageKind,
  Participant,
  Platform,
  Reaction,
} from './types';

/** What a connector or importer reports about a conversation. Ids are platform-native. */
export interface ConversationInput {
  platform: Platform;
  nativeId: string;
  /** Omit to keep the current title (or fall back to the native id for new conversations). */
  title?: string;
  /** The app's own unread count, for sources that can read it. Omit to let the hub count. */
  unreadCount?: number;
  isGroup?: boolean;
  /** Merged into the known participants by id. */
  participants?: Participant[];
}

/** What a connector or importer reports about a message. Ids are platform-native. */
export interface MessageInput {
  conversationNativeId: string;
  nativeId: string;
  senderId: string;
  senderName: string;
  fromSelf: boolean;
  timestamp: number;
  kind: MessageKind;
  text: string | null;
  attachments?: Attachment[];
  reactions?: Reaction[];
  replyToNativeId?: string | null;
  status?: DeliveryStatus | null;
  edited?: boolean;
  deleted?: boolean;
}

/** A change to a message that already exists: an edit, a delete, a receipt or a reaction. */
export interface MessagePatch {
  conversationNativeId: string;
  nativeId: string;
  text?: string | null;
  edited?: boolean;
  deleted?: boolean;
  status?: DeliveryStatus;
  /** Adds or replaces this sender's reaction; an empty emoji removes it. */
  reaction?: Reaction;
  /** Replaces the attachments, e.g. once media has been downloaded. */
  attachments?: Attachment[];
}

export interface UpsertOptions {
  /** Count new messages from others as unread. True for live traffic, false for history backfill. */
  countUnread: boolean;
}

/**
 * The connector's only way to talk to the rest of the app. The hub behind it
 * namespaces ids by connector, persists everything and fans out events.
 */
export interface ConnectorContext {
  upsertConversation(input: ConversationInput): void;
  upsertMessages(inputs: MessageInput[], options: UpsertOptions): void;
  patchMessage(patch: MessagePatch): void;
  setStatus(status: Omit<ConnectorStatus, 'id' | 'platform' | 'label'>): void;
  /** Store media bytes and get back a URL the web client can load. */
  saveMedia(data: Uint8Array, hint: { fileName?: string; mimeType?: string }): string;
  /** Directory the connector may use for credentials and caches. */
  dataDir: string;
  log: (level: 'info' | 'warn' | 'error', message: string, extra?: unknown) => void;
}

/**
 * Mirrors a messaging app that is already running on this machine. It reads
 * what the app shows or stores; it never talks to the service itself and
 * never sends. Implementations normalise what they read into
 * ConversationInput/MessageInput and push it through the context.
 */
export interface Connector {
  readonly id: string;
  readonly platform: Platform;
  readonly label: string;
  /** Whether to start watching at boot, e.g. because the app's data is present. */
  shouldAutoStart(dataDir: string): Promise<boolean>;
  start(ctx: ConnectorContext): Promise<void>;
  stop(): Promise<void>;
  /** Absolute path of a media file the app stores locally, for an attachment URL this connector issued. */
  mediaFile?(ref: string): string | null;
  /** For sources the browser extension pushes into: accept one capture (untrusted JSON). */
  receive?(body: unknown): { conversationId: string; added: number };
  /** For push sources: the extension is alive and a matching tab is open. */
  heartbeat?(): void;
}
