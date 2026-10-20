import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ConversationInput, MessageInput } from '../../core/connector';
import type { Attachment, AttachmentType, MessageKind, Participant, Reaction } from '../../core/types';
import { decodeQuote, decodeReactions, type Quote } from './protobuf';

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

/** ZWACHATSESSION.ZSESSIONTYPE: 0 one-to-one, 1 group, 4 a community's announcement group; others are broadcasts and status. */
const SESSION_TYPE = { individual: 0, group: 1, announcements: 4 } as const;

/**
 * ZWAMESSAGE.ZMESSAGETYPE codes that independent readers agree on. Others
 * (calls, polls, ...) disagree between projects, so they're shown as text
 * when they carry some and skipped otherwise.
 */
const MESSAGE_TYPES: Record<
  number,
  { kind: MessageKind; attachment?: AttachmentType; deleted?: boolean; fallbackText?: string }
> = {
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
  54: { kind: 'media', attachment: 'video' },
  59: { kind: 'system', fallbackText: '📞 Call' },
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

/** The chat list at one moment, ready to upsert. */
export interface ChatSnapshot {
  chats: ChatRow[];
  /** Conversation id of each visible chat session, by Z_PK. */
  sessions: Map<number, string>;
  /** LID chats now known by phone number: their old conversation folds into the phone-number one. */
  folded: { from: string; into: string }[];
}

export interface MessageRow {
  pk: number;
  input: MessageInput;
  /** A local media file reference (`media:<Z_PK>`) for the connector to resolve, if any. */
  mediaRef: string | null;
  /**
   * History sync writes some rows with ZSORT < 0. Usually they're the only
   * copy, but when a regular row exists too it wins.
   */
  duplicate: boolean;
  /** The parts of the stored row that can change later: edits, deletes, media arriving, reactions. */
  state: { type: number; text: string | null; media: string | null; reactions: string };
  chatPk: number;
  stanza: string | null;
}

export interface MessageBatch {
  rows: MessageRow[];
  /** Z_PK of the last row scanned, mapped or not: where the next batch starts. */
  lastPk: number;
  /** Rows scanned. Fewer than the limit means there's nothing more. */
  scanned: number;
  /** Set when a row named a chat the last snapshot didn't have, so the chat list was read again. */
  snapshot: ChatSnapshot | null;
}

interface ChatInfo {
  jid: string;
  isGroup: boolean;
  title: string;
}

export class ChatStorageReader {
  private readonly columns = new Map<string, Set<string>>();
  /** Visible chats by ZWACHATSESSION.Z_PK. */
  private chats = new Map<number, ChatInfo>();
  /** Every chat session at the last snapshot, visible or not, to notice new ones. */
  private sessions = new Set<number>();
  /** Raw member JIDs of each group, to find the groups a newly mapped LID belongs to. */
  private rawMembers = new Map<number, Set<string>>();
  private pushNames = new Map<string, string>();
  /** One-to-one chat titles by JID, the fallback for naming people elsewhere (reactions, groups). */
  private partnerNames = new Map<string, string>();

  constructor(
    private readonly db: DatabaseSync,
    private contacts: ContactBook = new ContactBook(),
  ) {}

  /** Names and LID mappings changed; the next snapshot uses the new ones. */
  setContacts(contacts: ContactBook): void {
    this.contacts = contacts;
  }

  private columnsOf(table: string): Set<string> {
    let cols = this.columns.get(table);
    if (!cols) {
      cols = columnSet(this.db, table);
      this.columns.set(table, cols);
    }
    return cols;
  }

  private has(table: string, ...cols: string[]): boolean {
    const present = this.columnsOf(table);
    return present.size > 0 && cols.every((c) => present.has(c));
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
    if (!this.has('ZWAPROFILEPUSHNAME', 'ZJID', 'ZPUSHNAME')) return;
    const rows = this.db.prepare('SELECT ZJID AS jid, ZPUSHNAME AS name FROM ZWAPROFILEPUSHNAME').all();
    this.pushNames = new Map(rows.filter((r) => str(r.jid) && str(r.name)).map((r) => [String(r.jid), String(r.name)]));
  }

  /**
   * One-to-one and group chats with their members, skipping status,
   * broadcasts, channels and hidden or removed chats. Run it inside the same
   * read transaction as the messages it should explain.
   */
  snapshot(): ChatSnapshot {
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
    const chats = new Map<number, ChatInfo>();
    const sessions = new Set<number>();
    const folded = new Map<string, string>();
    for (const r of this.db.prepare(`SELECT c.Z_PK AS pk, ${cols} FROM ZWACHATSESSION c ORDER BY c.Z_PK`).all()) {
      sessions.add(Number(r.pk));
      const raw = str(r.ZCONTACTJID);
      const type = Number(r.ZSESSIONTYPE ?? 0);
      if (!raw || IGNORED_JIDS.test(raw)) continue;
      if (Number(r.ZREMOVED ?? 0) === 1 || Number(r.ZHIDDEN ?? 0) === 1) continue;
      if (type !== SESSION_TYPE.individual && type !== SESSION_TYPE.group && type !== SESSION_TYPE.announcements) {
        continue;
      }
      const isGroup = type !== SESSION_TYPE.individual || raw.endsWith('@g.us');
      // The same person can have a LID chat and a phone-number chat; show them as one.
      const jid = isGroup ? raw : this.contacts.canonical(raw);
      if (jid !== raw) folded.set(raw, jid);
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
    this.sessions = sessions;
    this.partnerNames = new Map(
      [...byJid.values()]
        .filter((c) => !c.input.isGroup && c.input.title !== jidLabel(c.input.nativeId))
        .map((c) => [c.input.nativeId, c.input.title!]),
    );

    for (const [jid, participants] of this.readGroupMembers()) {
      const chat = byJid.get(jid);
      if (chat) chat.input.participants = [...participants, ...(chat.input.participants ?? [])];
    }
    return {
      chats: [...byJid.values()],
      sessions: new Map([...chats].map(([pk, chat]) => [pk, chat.jid])),
      folded: [...folded].map(([from, into]) => ({ from, into })),
    };
  }

  private readGroupMembers(): Map<string, Participant[]> {
    const members = new Map<string, Participant[]>();
    this.rawMembers = new Map();
    if (!this.has('ZWAGROUPMEMBER', 'ZCHATSESSION', 'ZMEMBERJID')) return members;
    const cols = this.select('ZWAGROUPMEMBER', 'g', [
      'ZCHATSESSION',
      'ZMEMBERJID',
      'ZCONTACTNAME',
      'ZFIRSTNAME',
      'ZISACTIVE',
    ]);
    for (const r of this.db.prepare(`SELECT ${cols} FROM ZWAGROUPMEMBER g`).all()) {
      const pk = Number(r.ZCHATSESSION);
      const chat = this.chats.get(pk);
      const raw = str(r.ZMEMBERJID);
      if (!chat?.isGroup || !raw) continue;
      // Former members still sent messages; their LIDs count for remapping.
      const seen = this.rawMembers.get(pk) ?? new Set();
      seen.add(raw);
      this.rawMembers.set(pk, seen);
      if (r.ZISACTIVE === 0) continue;
      const id = this.contacts.canonical(raw);
      const name =
        this.contacts.name(id) ?? str(r.ZCONTACTNAME) ?? str(r.ZFIRSTNAME) ?? this.nameFor(id) ?? jidLabel(id);
      const list = members.get(chat.jid) ?? [];
      if (!list.some((p) => p.id === id)) list.push({ id, name, isSelf: false });
      members.set(chat.jid, list);
    }
    return members;
  }

  /** Group chats (by Z_PK) that have or had any of these JIDs as members. */
  groupsWith(jids: Set<string>): number[] {
    return [...this.rawMembers].filter(([, members]) => [...members].some((jid) => jids.has(jid))).map(([pk]) => pk);
  }

  private messageQuery(where: string): string {
    const msg = this.columnsOf('ZWAMESSAGE');
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
    ]);
    const parts = ['m.Z_PK AS pk', m];
    const joins: string[] = [];

    if (msg.has('ZGROUPMEMBER') && this.has('ZWAGROUPMEMBER')) {
      parts.push(this.select('ZWAGROUPMEMBER', 'g', ['ZMEMBERJID', 'ZCONTACTNAME', 'ZFIRSTNAME'], 'G_'));
      joins.push('LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK = m.ZGROUPMEMBER');
    } else parts.push('NULL AS G_ZMEMBERJID, NULL AS G_ZCONTACTNAME, NULL AS G_ZFIRSTNAME');

    // ZMETADATA holds reply context, so even plain text can have a media item.
    const mediaCols = ['ZMEDIALOCALPATH', 'ZTITLE', 'ZLATITUDE', 'ZLONGITUDE', 'ZVCARDNAME', 'ZMETADATA'];
    const media = this.columnsOf('ZWAMEDIAITEM');
    // Versions link either way: message → media item, or media item → message.
    const forward = media.size > 0 && msg.has('ZMEDIAITEM');
    const back = media.has('ZMESSAGE');
    if (forward || back) {
      if (forward) joins.push('LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM');
      if (back) {
        joins.push(
          forward
            ? 'LEFT JOIN ZWAMEDIAITEM mb ON COALESCE(m.ZMEDIAITEM, 0) = 0 AND mb.ZMESSAGE = m.Z_PK'
            : 'LEFT JOIN ZWAMEDIAITEM mb ON mb.ZMESSAGE = m.Z_PK',
        );
      }
      const from = (col: string) => [...(forward ? [`mi.${col}`] : []), ...(back ? [`mb.${col}`] : [])];
      const pick = (col: string) =>
        media.has(col) ? `COALESCE(${[...from(col), 'NULL'].join(', ')}) AS MI_${col}` : `NULL AS MI_${col}`;
      parts.push(`COALESCE(${[...from('Z_PK'), 'NULL'].join(', ')}) AS MI_PK`, ...mediaCols.map(pick));
    } else parts.push('NULL AS MI_PK', ...mediaCols.map((c) => `NULL AS MI_${c}`));

    if (msg.has('ZMESSAGEINFO') && this.has('ZWAMESSAGEINFO', 'ZRECEIPTINFO')) {
      parts.push('info.ZRECEIPTINFO AS I_ZRECEIPTINFO');
      joins.push('LEFT JOIN ZWAMESSAGEINFO info ON info.Z_PK = m.ZMESSAGEINFO');
    } else parts.push('NULL AS I_ZRECEIPTINFO');

    return `SELECT ${parts.join(', ')} FROM ZWAMESSAGE m ${joins.join(' ')} WHERE ${where}`;
  }

  /**
   * Rows with Z_PK above `afterPk` (and at most `untilPk`, optionally in some
   * chats only), oldest first. Rows that don't map (status updates, hidden
   * chats) are skipped but still move `lastPk` on.
   */
  readMessages(range: { afterPk: number; limit: number; untilPk?: number; chats?: number[] }): MessageBatch {
    const where = ['m.Z_PK > ?'];
    const params: number[] = [range.afterPk];
    if (range.untilPk !== undefined) {
      where.push('m.Z_PK <= ?');
      params.push(range.untilPk);
    }
    if (range.chats) {
      where.push(`m.ZCHATSESSION IN (${range.chats.map(() => '?').join(', ')})`);
      params.push(...range.chats);
    }
    const raw = this.db
      .prepare(`${this.messageQuery(where.join(' AND '))} ORDER BY m.Z_PK LIMIT ?`)
      .all(...params, range.limit);
    const { rows, snapshot } = this.mapRows(raw);
    return { rows, lastPk: raw.length ? Number(raw.at(-1)!.pk) : range.afterPk, scanned: raw.length, snapshot };
  }

  /** The newest `count` rows, to notice edits, deletes and reactions (which rewrite rows in place). */
  readRecentMessages(count: number): { rows: MessageRow[]; snapshot: ChatSnapshot | null } {
    const raw = this.db
      .prepare(`${this.messageQuery('m.Z_PK > (SELECT COALESCE(MAX(Z_PK), 0) - ? FROM ZWAMESSAGE)')} ORDER BY m.Z_PK`)
      .all(count);
    return this.mapRows(raw);
  }

  /** Whether a ZSORT < 0 row has a regular copy that should win over it. */
  hasRegularCopy(row: MessageRow): boolean {
    if (!row.stanza || !this.has('ZWAMESSAGE', 'ZSORT', 'ZSTANZAID')) return false;
    return (
      this.db
        .prepare(
          'SELECT 1 FROM ZWAMESSAGE WHERE ZCHATSESSION = ? AND ZSTANZAID = ? AND ZISFROMME = ? AND COALESCE(ZSORT, 0) >= 0 LIMIT 1',
        )
        .get(row.chatPk, row.stanza, row.input.fromSelf ? 1 : 0) !== undefined
    );
  }

  private mapRows(raw: Row[]): { rows: MessageRow[]; snapshot: ChatSnapshot | null } {
    // A chat created after the last snapshot: read the chat list again in this
    // same transaction, or its first messages would be dropped for good.
    const unknown = raw.some((r) => r.ZCHATSESSION != null && !this.sessions.has(Number(r.ZCHATSESSION)));
    const snapshot = unknown ? this.snapshot() : null;

    const quotes = new Map<MessageRow, Quote>();
    const rows: MessageRow[] = [];
    for (const r of raw) {
      const row = this.toMessage(r);
      if (!row) continue;
      rows.push(row);
      const quote = r.MI_ZMETADATA instanceof Uint8Array ? decodeQuote(r.MI_ZMETADATA) : null;
      if (quote) quotes.set(row, quote);
    }
    if (quotes.size) this.linkReplies(quotes);
    return { rows, snapshot };
  }

  /**
   * A reply's metadata names the quoted message's stanza id; its direction
   * (which decides the `me_` prefix) comes from the quoted row itself.
   */
  private linkReplies(quotes: Map<MessageRow, Quote>): void {
    const direction = new Map<string, boolean>();
    if (this.columnsOf('ZWAMESSAGE').has('ZSTANZAID')) {
      const stanzas = [...new Set([...quotes.values()].map((q) => q.stanza))];
      for (let i = 0; i < stanzas.length; i += 500) {
        const chunk = stanzas.slice(i, i + 500);
        const found = this.db
          .prepare(
            `SELECT ZSTANZAID AS stanza, ZCHATSESSION AS chat, ZISFROMME AS me FROM ZWAMESSAGE WHERE ZSTANZAID IN (${chunk.map(() => '?').join(', ')})`,
          )
          .all(...chunk);
        for (const f of found) direction.set(`${Number(f.chat)}\0${String(f.stanza)}`, Number(f.me) === 1);
      }
    }
    for (const [row, quote] of quotes) {
      // Not on this Mac: the quote's sender is absent for your own messages.
      const fromSelf = direction.get(`${row.chatPk}\0${quote.stanza}`) ?? quote.senderJid === null;
      row.input.replyToNativeId = `${fromSelf ? 'me_' : ''}${quote.stanza}`;
    }
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
    let text = str(r.ZTEXT) ?? known?.fallbackText ?? null;
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
      replyToNativeId: null,
      deleted,
    };
    return {
      pk: Number(r.pk),
      input,
      mediaRef: deleted ? null : mediaRef,
      duplicate: Number(r.ZSORT ?? 0) < 0,
      state: { type, text, media: str(r.MI_ZMEDIALOCALPATH), reactions: JSON.stringify(reactions) },
      chatPk: Number(r.ZCHATSESSION),
      stanza,
    };
  }
}
