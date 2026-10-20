/**
 * The platform-neutral domain model. Everything above the connector layer
 * (store, API, web UI, insights) speaks only these types, so adding a new
 * messaging service means writing a connector or importer, nothing else.
 *
 * This file is shared with the web client, so it must stay free of Node imports.
 */

import type { AssignedGroup, GroupAlerts } from './groups';

export type Platform = 'whatsapp' | 'instagram';

/**
 * `live` conversations mirror an app running on this machine; you reply in that app.
 * `import` conversations are snapshots loaded from an export file.
 */
export type SourceKind = 'live' | 'import';

export interface Participant {
  /** Platform-native id: a WhatsApp JID, an Instagram id, or the display name for imports. */
  id: string;
  name: string;
  isSelf: boolean;
}

export interface Conversation {
  /** `${sourceId}:${nativeId}`, stable across restarts. */
  id: string;
  /** Which connector or importer produced it, e.g. `whatsapp` or `import:instagram`. */
  sourceId: string;
  sourceKind: SourceKind;
  platform: Platform;
  nativeId: string;
  title: string;
  isGroup: boolean;
  participants: Participant[];
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  messageCount: number;
  /** Close friends, Romantic interests or Ghosts, as you set it. See core/groups.ts for Dates and automatic Ghosts. */
  group: AssignedGroup;
  /** A scheduled date, epoch ms. */
  dateAt: number | null;
  /** When the group or date was last changed, epoch ms. */
  groupSetAt: number | null;
}

export type MessageKind = 'text' | 'media' | 'system';

export type AttachmentType =
  'image' | 'video' | 'audio' | 'sticker' | 'document' | 'location' | 'contact' | 'link' | 'other';

export interface Attachment {
  type: AttachmentType;
  name?: string;
  mimeType?: string;
  /** Served by this app (`/api/media/...`) or an external link. Absent when the file wasn't available. */
  url?: string;
}

export interface Reaction {
  emoji: string;
  senderId: string;
  senderName: string;
}

export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  /** `${conversationId}:${nativeId}` */
  id: string;
  conversationId: string;
  nativeId: string;
  senderId: string;
  senderName: string;
  fromSelf: boolean;
  /** Milliseconds since the epoch. */
  timestamp: number;
  kind: MessageKind;
  text: string | null;
  attachments: Attachment[];
  reactions: Reaction[];
  replyToNativeId: string | null;
  status: DeliveryStatus | null;
  edited: boolean;
  deleted: boolean;
}

/** `needs_setup`: the app isn't installed, a permission is missing, or the extension isn't talking to us. */
export type ConnectorState = 'stopped' | 'starting' | 'needs_setup' | 'connected' | 'error';

export interface ConnectorStatus {
  id: string;
  platform: Platform;
  label: string;
  state: ConnectorState;
  /** Human-readable detail: what it's watching, what setup is missing, an error. */
  detail?: string;
}

export interface MessagePage {
  messages: Message[];
  /** Pass back as `before` to load older messages; null when there are none. */
  nextCursor: string | null;
}

export type HubEvent =
  | { type: 'conversation.upserted'; conversation: Conversation }
  | { type: 'conversation.deleted'; conversationId: string }
  | { type: 'message.upserted'; message: Message }
  /** Many messages changed at once (history sync, import); clients should reload the conversation. */
  | { type: 'messages.bulk'; conversationId: string }
  | { type: 'connector.status'; status: ConnectorStatus }
  | { type: 'settings.updated'; settings: Settings };

export interface Settings {
  /** Desktop alerts for new messages, per group. */
  groupAlerts: GroupAlerts;
}
