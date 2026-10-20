import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ConversationInput, MessageInput } from '../../core/connector';
import type { Attachment, AttachmentType, MessageKind, Participant, Reaction } from '../../core/types';
import { decodeReactions } from './protobuf';

/**
 * Reads WhatsApp Desktop for macOS's own message store (ChatStorage.sqlite), a
 * Core Data database with the same layout as WhatsApp on iPhone. Read-only:
 * nothing here writes, and nothing talks to WhatsApp's servers.
 *
 * The schema is private and drifts between versions, so every query is built
 * from the columns that actually exist; missing ones read as NULL.
 */

/** Core Data stores dates as seconds since 2001-01-01 UTC. */
const APPLE_EPOCH_OFFSET_S = 978_307_200;

export function appleDateToMs(value: SQLOutputValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  // Sentinels (0, huge values) show up in real stores; anything before 2009 can't be a WhatsApp message.
  if (!Number.isFinite(seconds) || seconds < 252_460_800 || seconds > 4_102_444_800) return null;
  return Math.round((seconds + APPLE_EPOCH_OFFSET_S) * 1000);
}

/** ZWACHATSESSION.ZSESSIONTYPE: 0 one-to-one, 1 group; higher values are broadcasts, status, communities. */
const SESSION_TYPE = { individual: 0, group: 1 } as const;

/**
 * ZWAMESSAGE.ZMESSAGETYPE codes that independent readers agree on. Others
 * (calls, polls, ...) disagree between projects, so they're shown as text
 * when they carry some and skipped otherwise.
 */
const MESSAGE_TYPES: Record<number, { kind: MessageKind; attachment?: AttachmentType; deleted?: boolean }> = {
  0: { kind: 'text' },
  1: { kind: 'media', attachment: 'image' },
  2: { kind: 'media', attachment: 'video' },
  3: { kind: 'media', attachment: 'audio' },
  4: { kind: 'media', attachment: 'contact' },
  5: { kind: 'media', attachment: 'location' },
  6: { kind: 'system' },
  7: { kind: 'text' }, // text with a link preview
  8: { kind: 'media', attachment: 'document' },
  11: { kind: 'media', attachment: 'video' }, // GIF
  14: { kind: 'text', deleted: true }, // deleted for everyone; ZTEXT may hold the deleting admin's JID
  15: { kind: 'media', attachment: 'sticker' },
};

const IGNORED_JIDS = /(@broadcast|@newsletter|@call)$/;

type Row = Record<string, SQLOutputValue | undefined>;

function str(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** A readable label for a JID with no known name. LIDs are opaque, so they get none. */
export function jidLabel(jid: string): string {
  const [user, server] = jid.split('@');
  if (server === 's.whatsapp.net' && user && /^\d+$/.test(user)) return `+${user}`;
  return 'Unknown';
}

function lidJid(value: string): string {
  return value.includes('@') ? value : `${value}@lid`;
}

function phoneJid(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 6 ? `${digits}@s.whatsapp.net` : null;
}

/**
 * Names and identities from WhatsApp's side databases. WhatsApp is moving
 * people from phone-number JIDs to opaque LIDs, so one person can appear as
 * both; `canonical` folds a LID into the phone-number JID when it's known.
 */
export class ContactBook {
  constructor(
    readonly names: Map<string, string> = new Map(),
    readonly lidToPhone: Map<string, string> = new Map(),
  ) {}

  canonical(jid: string): string {
    return jid.endsWith('@lid') ? (this.lidToPhone.get(jid) ?? jid) : jid;
  }

  name(jid: string): string | undefined {
    return this.names.get(jid) ?? this.names.get(this.canonical(jid));
  }
}

function columnSet(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => String(r.name)),
  );
}

/** Build a ContactBook from ContactsV2.sqlite and LID.sqlite, either of which may be missing. */
export function readContactBook(contacts?: DatabaseSync, lid?: DatabaseSync): ContactBook {
  const book = new ContactBook();
  if (lid) {
    const cols = columnSet(lid, 'ZWAZACCOUNT');
    if (cols.has('ZIDENTIFIER') && cols.has('ZPHONENUMBER')) {
      const nameCol = cols.has('ZDISPLAYNAME') ? 'ZDISPLAYNAME' : 'NULL';
      for (const r of lid
        .prepare(`SELECT ZIDENTIFIER AS id, ZPHONENUMBER AS phone, ${nameCol} AS name FROM ZWAZACCOUNT`)
        .all()) {
        const id = str(r.id);
        if (!id) continue;
        const phone = str(r.phone) ? phoneJid(String(r.phone)) : null;
        if (phone) book.lidToPhone.set(lidJid(id), phone);
        if (str(r.name)) book.names.set(phone ?? lidJid(id), String(r.name));
      }
    }
  }
  if (contacts) {
    const cols = columnSet(contacts, 'ZWAADDRESSBOOKCONTACT');
    if (cols.has('ZWHATSAPPID') && cols.has('ZFULLNAME')) {
      const lidCol = cols.has('ZLID') ? 'ZLID' : 'NULL';
      for (const r of contacts
        .prepare(`SELECT ZWHATSAPPID AS jid, ZFULLNAME AS name, ${lidCol} AS lid FROM ZWAADDRESSBOOKCONTACT`)
        .all()) {
        const jid = str(r.jid);
        const name = str(r.name);
        const lidValue = str(r.lid);
        if (jid && lidValue && !jid.endsWith('@lid')) book.lidToPhone.set(lidJid(lidValue), jid);
        // Saved address-book names beat everything else, so they're written last.
        if (name && jid) book.names.set(jid, name);
        if (name && lidValue) book.names.set(lidJid(lidValue), name);
      }
    }
  }
  return book;
}

export interface ChatRow {
  input: ConversationInput & { unreadCount: number };
}

export interface MessageRow {
  pk: number;
  input: MessageInput;
  /** A local media file reference (`media:<Z_PK>`) for the connector to resolve, if any. */
  mediaRef: string | null;
  /** History sync leaves lower-priority duplicate rows (ZSORT < 0) for some messages. */
  duplicate: boolean;
  /** The parts of the stored row that can change later: edits, deletes, media arriving. */
  state: { type: number; text: string | null; media: string | null };
}

export class ChatStorageReader {
  private readonly columns = new Map<string, Set<string>>();
  private chats = new Map<number, { jid: string; isGroup: boolean; title: string }>();
  private pushNames = new Map<string, string>();
  /** One-to-one chat titles by JID, the fallback for naming people elsewhere (reactions, groups). */
  private partnerNames = new Map<string, string>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly contacts: ContactBook = new ContactBook(),
  ) {}

  private columnsOf(table: string): Set<string> {
    let cols = this.columns.get(table);
    if (!cols) {
      cols = columnSet(this.db, table);
      this.columns.set(table, cols);
    }
    return cols;
  }

  hasTable(table: string): boolean {
    return this.columnsOf(table).size > 0;
  }

  /** Columns a usable store must have; reading without them would misread, so refuse instead. */
  missingRequired(): string[] {
    const required: [string, string[]][] = [
      ['ZWACHATSESSION', ['Z_PK', 'ZCONTACTJID', 'ZSESSIONTYPE']],
      ['ZWAMESSAGE', ['Z_PK', 'ZCHATSESSION', 'ZISFROMME', 'ZMESSAGEDATE', 'ZMESSAGETYPE', 'ZTEXT']],
    ];
    return required.flatMap(([table, cols]) =>
      cols.filter((c) => !this.columnsOf(table).has(c)).map((c) => `${table}.${c}`),
    );
  }

  /** `alias.COL AS COL`, or `NULL AS COL` when this app version lacks the column. */
  private select(table: string, alias: string, cols: string[], prefix = ''): string {
    const present = this.columnsOf(table);
    return cols.map((c) => (present.has(c) ? `${alias}.${c} AS ${prefix}${c}` : `NULL AS ${prefix}${c}`)).join(', ');
  }

  /** Bumps whenever another connection (WhatsApp) commits. Cheap to poll. */
  dataVersion(): number {
    return Number(this.db.prepare('PRAGMA data_version').get()?.data_version ?? 0);
  }

  maxMessagePk(): number {
    return Number(this.db.prepare('SELECT MAX(Z_PK) AS pk FROM ZWAMESSAGE').get()?.pk ?? 0);
  }

  private nameFor(jid: string): string | undefined {
    const canonical = this.contacts.canonical(jid);
    return (
      this.contacts.name(jid) ??
      this.partnerNames.get(canonical) ??
      this.pushNames.get(jid) ??
      this.pushNames.get(canonical)
    );
  }

  private loadPushNames(): void {
    if (!this.columnsOf('ZWAPROFILEPUSHNAME').has('ZPUSHNAME')) return;
    const rows = this.db.prepare('SELECT ZJID AS jid, ZPUSHNAME AS name FROM ZWAPROFILEPUSHNAME').all();
    this.pushNames = new Map(rows.filter((r) => str(r.jid) && str(r.name)).map((r) => [String(r.jid), String(r.name)]));
  }

  /** One-to-one and group chats, skipping status, broadcasts, channels and hidden or removed chats. */
  readChats(): ChatRow[] {
    this.loadPushNames();
    const cols = this.select('ZWACHATSESSION', 'c', [
      'ZCONTACTJID',
      'ZPARTNERNAME',
      'ZSESSIONTYPE',
      'ZUNREADCOUNT',
      'ZREMOVED',
      'ZHIDDEN',
    ]);
    const byJid = new Map<string, ChatRow>();
    const chats = new Map<number, { jid: string; isGroup: boolean; title: string }>();
    for (const r of this.db.prepare(`SELECT c.Z_PK AS pk, ${cols} FROM ZWACHATSESSION c ORDER BY c.Z_PK`).all()) {
      const raw = str(r.ZCONTACTJID);
      const type = Number(r.ZSESSIONTYPE ?? 0);
      if (!raw || IGNORED_JIDS.test(raw)) continue;
      if (Number(r.ZREMOVED ?? 0) === 1 || Number(r.ZHIDDEN ?? 0) === 1) continue;
      if (type !== SESSION_TYPE.individual && type !== SESSION_TYPE.group) continue;
      const isGroup = type === SESSION_TYPE.group || raw.endsWith('@g.us');
      // The same person can have a LID chat and a phone-number chat; show them as one.
      const jid = isGroup ? raw : this.contacts.canonical(raw);
      const named = isGroup
        ? str(r.ZPARTNERNAME)
        : (this.contacts.name(jid) ?? str(r.ZPARTNERNAME) ?? this.nameFor(jid));
      const title = named ?? (isGroup ? 'Group' : jidLabel(jid));
      // -1 means "marked as unread" in the app.
      const unread = Number(r.ZUNREADCOUNT ?? 0);
      const unreadCount = unread < 0 ? 1 : unread;
      chats.set(Number(r.pk), { jid, isGroup, title });
      const existing = byJid.get(jid)?.input;
      const bestTitle = existing && existing.title !== jidLabel(jid) && !named ? existing.title! : title;
      byJid.set(jid, {
        input: {
          platform: 'whatsapp',
          nativeId: jid,
          title: bestTitle,
          isGroup,
          unreadCount: Math.max(unreadCount, existing?.unreadCount ?? 0),
          participants: [
            ...(isGroup ? [] : [{ id: jid, name: bestTitle, isSelf: false }]),
            { id: 'me', name: 'You', isSelf: true },
          ],
        },
      });
    }
    // Messages in a merged LID chat should carry the merged chat's title.
    for (const chat of chats.values()) chat.title = byJid.get(chat.jid)?.input.title ?? chat.title;
    this.chats = chats;
    this.partnerNames = new Map(
      [...byJid.values()]
        .filter((c) => !c.input.isGroup && c.input.title !== jidLabel(c.input.nativeId))
        .map((c) => [c.input.nativeId, c.input.title!]),
    );
    return [...byJid.values()];
  }

  /** Group membership, for participant lists. Call readChats() first. */
  readGroupMembers(): Map<string, Participant[]> {
    const members = new Map<string, Participant[]>();
    if (!this.hasTable('ZWAGROUPMEMBER')) return members;
    const cols = this.select('ZWAGROUPMEMBER', 'g', [
      'ZCHATSESSION',
      'ZMEMBERJID',
      'ZCONTACTNAME',
      'ZFIRSTNAME',
      'ZISACTIVE',
    ]);
    for (const r of this.db.prepare(`SELECT ${cols} FROM ZWAGROUPMEMBER g`).all()) {
      const chat = this.chats.get(Number(r.ZCHATSESSION));
      const raw = str(r.ZMEMBERJID);
      if (!chat?.isGroup || !raw || r.ZISACTIVE === 0) continue;
      const id = this.contacts.canonical(raw);
      const name =
        this.contacts.name(id) ?? str(r.ZCONTACTNAME) ?? str(r.ZFIRSTNAME) ?? this.nameFor(id) ?? jidLabel(id);
      const list = members.get(chat.jid) ?? [];
      if (!list.some((p) => p.id === id)) list.push({ id, name, isSelf: false });
      members.set(chat.jid, list);
    }
    return members;
  }

  private messageQuery(where: string): string {
    const m = this.select('ZWAMESSAGE', 'm', [
      'ZCHATSESSION',
      'ZISFROMME',
      'ZMESSAGEDATE',
      'ZFROMJID',
      'ZTEXT',
      'ZMESSAGETYPE',
      'ZSTANZAID',
      'ZPUSHNAME',
      'ZSORT',
      'ZGROUPMEMBER',
      'ZMEDIAITEM',
    ]);
    const parts = ['m.Z_PK AS pk', m];
    const joins: string[] = [];

    if (this.hasTable('ZWAGROUPMEMBER')) {
      parts.push(this.select('ZWAGROUPMEMBER', 'g', ['ZMEMBERJID', 'ZCONTACTNAME', 'ZFIRSTNAME'], 'G_'));
      joins.push('LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK = m.ZGROUPMEMBER');
    } else parts.push('NULL AS G_ZMEMBERJID, NULL AS G_ZCONTACTNAME, NULL AS G_ZFIRSTNAME');

    const mediaCols = ['ZMEDIALOCALPATH', 'ZTITLE', 'ZLATITUDE', 'ZLONGITUDE', 'ZVCARDNAME'];
    if (this.hasTable('ZWAMEDIAITEM') && this.columnsOf('ZWAMESSAGE').has('ZMEDIAITEM')) {
      const present = this.columnsOf('ZWAMEDIAITEM');
      // Versions link either way: message → media item, or media item → message.
      const back = present.has('ZMESSAGE');
      joins.push('LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM');
      if (back) joins.push('LEFT JOIN ZWAMEDIAITEM mb ON COALESCE(m.ZMEDIAITEM, 0) = 0 AND mb.ZMESSAGE = m.Z_PK');
      const pick = (col: string) =>
        present.has(col) ? `COALESCE(mi.${col}${back ? `, mb.${col}` : ''}) AS MI_${col}` : `NULL AS MI_${col}`;
      parts.push(`COALESCE(mi.Z_PK${back ? ', mb.Z_PK' : ''}) AS MI_PK`, ...mediaCols.map(pick));
    } else parts.push('NULL AS MI_PK', ...mediaCols.map((c) => `NULL AS MI_${c}`));

    if (this.columnsOf('ZWAMESSAGE').has('ZPARENTMESSAGE')) {
      parts.push('p.ZSTANZAID AS P_ZSTANZAID, p.ZISFROMME AS P_ZISFROMME');
      joins.push('LEFT JOIN ZWAMESSAGE p ON p.Z_PK = m.ZPARENTMESSAGE');
    } else parts.push('NULL AS P_ZSTANZAID, NULL AS P_ZISFROMME');

    if (this.columnsOf('ZWAMESSAGE').has('ZMESSAGEINFO') && this.columnsOf('ZWAMESSAGEINFO').has('ZRECEIPTINFO')) {
      parts.push('info.ZRECEIPTINFO AS I_ZRECEIPTINFO');
      joins.push('LEFT JOIN ZWAMESSAGEINFO info ON info.Z_PK = m.ZMESSAGEINFO');
    } else parts.push('NULL AS I_ZRECEIPTINFO');

    return `SELECT ${parts.join(', ')} FROM ZWAMESSAGE m ${joins.join(' ')} WHERE ${where}`;
  }

  /** Messages with Z_PK above `afterPk`, oldest first. Call readChats() first. */
  readMessagesAfter(afterPk: number, limit: number): MessageRow[] {
    const rows = this.db.prepare(`${this.messageQuery('m.Z_PK > ?')} ORDER BY m.Z_PK LIMIT ?`).all(afterPk, limit);
    return rows.map((r) => this.toMessage(r)).filter((m): m is MessageRow => m !== null);
  }

  /** The newest `count` rows, to notice edits and deletes (which rewrite rows in place). */
  readRecentMessages(count: number): MessageRow[] {
    const rows = this.db
      .prepare(`${this.messageQuery('m.Z_PK > (SELECT COALESCE(MAX(Z_PK), 0) - ? FROM ZWAMESSAGE)')} ORDER BY m.Z_PK`)
      .all(count);
    return rows.map((r) => this.toMessage(r)).filter((m): m is MessageRow => m !== null);
  }

  /** Local path of a media item, relative to the container's Message folder. */
  mediaPath(mediaPk: number): string | null {
    if (!this.columnsOf('ZWAMEDIAITEM').has('ZMEDIALOCALPATH')) return null;
    return str(this.db.prepare('SELECT ZMEDIALOCALPATH AS path FROM ZWAMEDIAITEM WHERE Z_PK = ?').get(mediaPk)?.path);
  }

  private groupSenderName(jid: string, row: Row): string {
    return (
      this.contacts.name(jid) ??
      str(row.G_ZCONTACTNAME) ??
      str(row.G_ZFIRSTNAME) ??
      this.nameFor(jid) ??
      str(row.ZPUSHNAME) ??
      jidLabel(jid)
    );
  }

  private toMessage(r: Row): MessageRow | null {
    const chat = this.chats.get(Number(r.ZCHATSESSION));
    const timestamp = appleDateToMs(r.ZMESSAGEDATE);
    if (!chat || timestamp === null) return null;

    const type = Number(r.ZMESSAGETYPE ?? 0);
    const known = MESSAGE_TYPES[type];
    let text = str(r.ZTEXT);
    if (!known && !text) return null;
    const kind: MessageKind = known?.kind ?? 'text';
    if (kind === 'system' && !text) return null; // group events without rendered text are noise

    const fromSelf = Number(r.ZISFROMME ?? 0) === 1;
    let senderId: string;
    let senderName: string;
    if (fromSelf) {
      senderId = 'me';
      senderName = 'You';
    } else if (chat.isGroup) {
      senderId = this.contacts.canonical(str(r.G_ZMEMBERJID) ?? str(r.ZFROMJID) ?? 'unknown');
      senderName = this.groupSenderName(senderId, r);
    } else {
      senderId = chat.jid;
      senderName = chat.title;
    }

    const attachments: Attachment[] = [];
    let mediaRef: string | null = null;
    if (known?.attachment) {
      const attachment: Attachment = { type: known.attachment };
      if (str(r.MI_ZMEDIALOCALPATH) && r.MI_PK != null) mediaRef = `media:${Number(r.MI_PK)}`;
      if (known.attachment === 'document' && str(r.MI_ZTITLE)) attachment.name = str(r.MI_ZTITLE)!;
      if (known.attachment === 'contact' && str(r.MI_ZVCARDNAME)) attachment.name = str(r.MI_ZVCARDNAME)!;
      if (known.attachment === 'location' && r.MI_ZLATITUDE != null && r.MI_ZLONGITUDE != null) {
        attachment.url = `https://maps.google.com/?q=${Number(r.MI_ZLATITUDE)},${Number(r.MI_ZLONGITUDE)}`;
      }
      attachments.push(attachment);
      // Captions live in the media item's title on some versions.
      if (!text && (known.attachment === 'image' || known.attachment === 'video')) text = str(r.MI_ZTITLE);
    }

    const reactions: Reaction[] =
      r.I_ZRECEIPTINFO instanceof Uint8Array
        ? decodeReactions(r.I_ZRECEIPTINFO).map(({ senderJid, emoji }) => {
            if (!senderJid) return { emoji, senderId: 'me', senderName: 'You' };
            const id = this.contacts.canonical(senderJid);
            return { emoji, senderId: id, senderName: this.nameFor(id) ?? jidLabel(id) };
          })
        : [];

    const stanza = str(r.ZSTANZAID);
    const parent = str(r.P_ZSTANZAID);
    const deleted = known?.deleted ?? false;
    const input: MessageInput = {
      conversationNativeId: chat.jid,
      // Stanza ids are only unique per direction within a chat.
      nativeId: stanza ? `${fromSelf ? 'me_' : ''}${stanza}` : `pk${Number(r.pk)}`,
      senderId,
      senderName,
      fromSelf,
      timestamp,
      kind,
      text: deleted ? null : text,
      attachments: deleted ? [] : attachments,
      reactions,
      replyToNativeId: parent ? `${Number(r.P_ZISFROMME) === 1 ? 'me_' : ''}${parent}` : null,
      deleted,
    };
    return {
      pk: Number(r.pk),
      input,
      mediaRef: deleted ? null : mediaRef,
      duplicate: Number(r.ZSORT ?? 0) < 0,
      state: { type, text, media: str(r.MI_ZMEDIALOCALPATH) },
    };
  }
}
