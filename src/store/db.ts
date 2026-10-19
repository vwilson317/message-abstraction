import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { Conversation, Message, MessagePage, Participant } from '../core/types';

type Row = Record<string, SQLOutputValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id                   TEXT PRIMARY KEY,
  source_id            TEXT NOT NULL,
  source_kind          TEXT NOT NULL,
  platform             TEXT NOT NULL,
  native_id            TEXT NOT NULL,
  title                TEXT NOT NULL,
  is_group             INTEGER NOT NULL DEFAULT 0,
  participants         TEXT NOT NULL DEFAULT '[]',
  last_message_at      INTEGER,
  last_message_preview TEXT,
  unread_count         INTEGER NOT NULL DEFAULT 0,
  message_count        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  native_id          TEXT NOT NULL,
  sender_id          TEXT NOT NULL,
  sender_name        TEXT NOT NULL,
  from_self          INTEGER NOT NULL,
  timestamp          INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  text               TEXT,
  attachments        TEXT NOT NULL DEFAULT '[]',
  reactions          TEXT NOT NULL DEFAULT '[]',
  reply_to_native_id TEXT,
  status             TEXT,
  edited             INTEGER NOT NULL DEFAULT 0,
  deleted            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS messages_by_conversation_time ON messages (conversation_id, timestamp);
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in a single transaction; much faster for bulk imports. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return row ? toConversation(row) : undefined;
  }

  listConversations(): Conversation[] {
    return this.db
      .prepare('SELECT * FROM conversations ORDER BY last_message_at IS NULL, last_message_at DESC')
      .all()
      .map(toConversation);
  }

  saveConversation(c: Conversation): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, source_id, source_kind, platform, native_id, title, is_group,
           participants, last_message_at, last_message_preview, unread_count, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title, is_group = excluded.is_group, participants = excluded.participants,
           last_message_at = excluded.last_message_at, last_message_preview = excluded.last_message_preview,
           unread_count = excluded.unread_count, message_count = excluded.message_count`,
      )
      .run(
        c.id,
        c.sourceId,
        c.sourceKind,
        c.platform,
        c.nativeId,
        c.title,
        Number(c.isGroup),
        JSON.stringify(c.participants),
        c.lastMessageAt,
        c.lastMessagePreview,
        c.unreadCount,
        c.messageCount,
      );
  }

  deleteConversation(id: string): boolean {
    return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
  }

  getMessage(id: string): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? toMessage(row) : undefined;
  }

  saveMessage(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, native_id, sender_id, sender_name, from_self, timestamp,
           kind, text, attachments, reactions, reply_to_native_id, status, edited, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           sender_name = excluded.sender_name, from_self = excluded.from_self, timestamp = excluded.timestamp,
           kind = excluded.kind, text = excluded.text, attachments = excluded.attachments,
           reactions = excluded.reactions, reply_to_native_id = excluded.reply_to_native_id,
           status = excluded.status, edited = excluded.edited, deleted = excluded.deleted`,
      )
      .run(
        m.id,
        m.conversationId,
        m.nativeId,
        m.senderId,
        m.senderName,
        Number(m.fromSelf),
        m.timestamp,
        m.kind,
        m.text,
        JSON.stringify(m.attachments),
        JSON.stringify(m.reactions),
        m.replyToNativeId,
        m.status,
        Number(m.edited),
        Number(m.deleted),
      );
  }

  /**
   * Newest-first pagination, returned oldest-first for display. The cursor is
   * `${timestamp}_${rowid}` so messages sharing a timestamp keep a stable order.
   */
  listMessages(conversationId: string, opts: { before?: string; limit?: number } = {}): MessagePage {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const [ts, rowid] = parseCursor(opts.before);
    const rows = this.db
      .prepare(
        `SELECT rowid AS _rowid, * FROM messages
         WHERE conversation_id = ? AND (timestamp < ? OR (timestamp = ? AND rowid < ?))
         ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(conversationId, ts, ts, rowid, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page.at(-1);
    return {
      messages: page.reverse().map(toMessage),
      nextCursor: hasMore && oldest ? `${oldest.timestamp}_${oldest._rowid}` : null,
    };
  }

  /** Every message in a conversation, oldest first. Used by insights and transcripts. */
  allMessages(conversationId: string): Message[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp, rowid')
      .all(conversationId)
      .map(toMessage);
  }

  latestMessage(conversationId: string): Message | undefined {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1')
      .get(conversationId);
    return row ? toMessage(row) : undefined;
  }

  /** Re-derive `from_self` after the user says which participant they are. */
  setSelfSender(conversationId: string, selfId: string | null): void {
    this.db
      .prepare('UPDATE messages SET from_self = (sender_id = ?) WHERE conversation_id = ?')
      .run(selfId ?? '', conversationId);
  }
}

function parseCursor(cursor: string | undefined): [number, number] {
  const match = cursor?.match(/^(-?\d+)_(\d+)$/);
  if (!match) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return [Number(match[1]), Number(match[2])];
}

function toConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    sourceKind: row.source_kind as Conversation['sourceKind'],
    platform: row.platform as Conversation['platform'],
    nativeId: String(row.native_id),
    title: String(row.title),
    isGroup: row.is_group === 1,
    participants: JSON.parse(String(row.participants)) as Participant[],
    lastMessageAt: row.last_message_at === null ? null : Number(row.last_message_at),
    lastMessagePreview: row.last_message_preview === null ? null : String(row.last_message_preview),
    unreadCount: Number(row.unread_count),
    messageCount: Number(row.message_count),
  };
}

function toMessage(row: Row): Message {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    nativeId: String(row.native_id),
    senderId: String(row.sender_id),
    senderName: String(row.sender_name),
    fromSelf: row.from_self === 1,
    timestamp: Number(row.timestamp),
    kind: row.kind as Message['kind'],
    text: row.text === null ? null : String(row.text),
    attachments: JSON.parse(String(row.attachments)),
    reactions: JSON.parse(String(row.reactions)),
    replyToNativeId: row.reply_to_native_id === null ? null : String(row.reply_to_native_id),
    status: (row.status ?? null) as Message['status'],
    edited: row.edited === 1,
    deleted: row.deleted === 1,
  };
}
