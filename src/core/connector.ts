import type {
  Attachment,
  ConnectorCapabilities,
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
  setStatus(status: Omit<ConnectorStatus, 'id' | 'platform' | 'label' | 'capabilities'>): void;
  /** Store media bytes and get back a URL the web client can load. */
  saveMedia(data: Uint8Array, hint: { fileName?: string; mimeType?: string }): string;
  /** Directory the connector may use for credentials and caches. */
  dataDir: string;
  log: (level: 'info' | 'warn' | 'error', message: string, extra?: unknown) => void;
}

/**
 * A live link to a messaging service. Implementations normalise the service's
 * events into ConversationInput/MessageInput and push them through the context.
 */
export interface Connector {
  readonly id: string;
  readonly platform: Platform;
  readonly label: string;
  readonly capabilities: ConnectorCapabilities;
  /** True when saved credentials exist in `dataDir`, so the hub can reconnect at boot. */
  hasSession(dataDir: string): Promise<boolean>;
  start(ctx: ConnectorContext): Promise<void>;
  /** Close the connection but keep credentials. */
  stop(): Promise<void>;
  /** Unlink this device and delete stored credentials. */
  logout(): Promise<void>;
  /** Send a text message and return it as it should be stored. */
  sendText?(conversationNativeId: string, text: string): Promise<MessageInput>;
}
