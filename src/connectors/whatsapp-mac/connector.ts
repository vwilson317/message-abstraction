import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Connector, ConnectorContext, MessageInput } from '../../core/connector';
import { ChatStorageReader, ContactBook, readContactBook, type ChatSnapshot, type MessageRow } from './reader';

type RowState = MessageRow['state'];

function sameState(a: RowState, b: RowState): boolean {
  return a.type === b.type && a.text === b.text && a.media === b.media && a.reactions === b.reactions;
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

export const DEFAULT_CONTAINER = join(homedir(), 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared');

/** Opens the Full Disk Access pane in System Settings. */
export const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

export interface WhatsAppMacOptions {
  /** WhatsApp's shared group container, holding ChatStorage.sqlite and Message/. */
  containerDir: string;
  pollMs: number;
}

/** Rows read per batch, yielding in between, so a large history doesn't block the server. */
const BATCH = 2000;
/** How far back to look for edits, deletes and reactions on each change. */
const RECENT_WINDOW = 300;
/** WhatsApp's side databases for names and LID ↔ phone-number mappings. */
const CONTACT_FILES = ['ContactsV2.sqlite', 'LID.sqlite'];

const PERMISSION_HELP =
  'macOS blocked access to WhatsApp’s data. Click Allow when macOS asks, or, so it stops asking, give the app you run the server from (Terminal, iTerm…) Full Disk Access in System Settings → Privacy & Security, restart it, then press Start.';

function isPermissionError(err: unknown): boolean {
  const text = String((err as Error)?.message ?? err);
  return /EPERM|EACCES|operation not permitted|authorization denied|not authorized|unable to open database/i.test(text);
}

/**
 * Mirrors WhatsApp Desktop for macOS by reading its local database, read-only.
 * It never talks to WhatsApp's servers and can't send; you reply in the app.
 *
 * The database is a linked-device cache: it holds what WhatsApp synced to the
 * Mac, not necessarily your whole history, and most media is never downloaded.
 */
export class WhatsAppMacConnector implements Connector {
  readonly id = 'whatsapp-mac';
  readonly platform = 'whatsapp' as const;
  readonly label = 'WhatsApp Desktop';

  private ctx?: ConnectorContext;
  private db?: DatabaseSync;
  private reader?: ChatStorageReader;
  private timer?: NodeJS.Timeout;
  /** Bumped by start() and stop(), so a sync from an earlier run stops quietly. */
  private session = 0;
  private running: Promise<void> = Promise.resolve();
  private syncing = false;
  private lastPk = 0;
  private lastVersion = -1;
  private contacts = new ContactBook();
  private contactsStamp = '';
  /** Last-seen state of recent rows, to spot edits and deletes (which rewrite rows in place). */
  private readonly recent = new Map<number, RowState>();
  private readonly chatState = new Map<string, string>();
  /** Conversation each visible chat session maps to, as of the last snapshot. */
  private sessions = new Map<number, string>();
  /** Chat sessions whose older rows need reading again: unhidden, or now known by another id. */
  private readonly rescan = new Set<number>();
  private folded: ChatSnapshot['folded'] = [];

  constructor(private readonly options: WhatsAppMacOptions) {}

  get dbPath(): string {
    return join(this.options.containerDir, 'ChatStorage.sqlite');
  }

  async shouldAutoStart(): Promise<boolean> {
    return existsSync(this.dbPath);
  }

  async start(ctx: ConnectorContext): Promise<void> {
    const session = ++this.session;
    this.ctx = ctx;
    this.reset();
    ctx.setStatus({ state: 'starting', detail: 'Opening WhatsApp Desktop’s database' });
    if (!existsSync(this.dbPath)) {
      ctx.setStatus({
        state: 'needs_setup',
        detail: `WhatsApp Desktop’s data wasn’t found at ${this.dbPath}. Install WhatsApp from the Mac App Store and sign in.`,
      });
      return;
    }
    try {
      this.db = this.open(this.dbPath);
      this.contactsStamp = this.stampContacts();
      this.contacts = this.loadContacts();
      this.reader = new ChatStorageReader(this.db, this.contacts);
      const missing = this.reader.missingRequired();
      if (missing.length) {
        throw new Error(
          `This WhatsApp version stores data differently (missing ${missing.join(', ')}). Not reading it.`,
        );
      }
    } catch (err) {
      this.close();
      const permission = isPermissionError(err);
      ctx.setStatus({
        state: permission ? 'needs_setup' : 'error',
        detail: permission ? PERMISSION_HELP : (err as Error).message,
      });
      ctx.log(permission ? 'warn' : 'error', 'Could not open ChatStorage.sqlite', err);
      return;
    }

    // The history read can take a while on a big store; don't hold up the server or other sources.
    this.running = this.sync(session, true);
    this.timer = setInterval(() => void this.poll(session), this.options.pollMs);
  }

  async stop(): Promise<void> {
    this.session++;
    clearInterval(this.timer);
    this.timer = undefined;
    this.close();
  }

  /** Resolves once the sync in progress, if any, has finished. */
  settled(): Promise<void> {
    return this.running;
  }

  /** Resolve a `media:<pk>` reference to a downloaded file inside WhatsApp's folders. */
  mediaFile(ref: string): string | null {
    const pk = Number(ref);
    if (!this.reader || !Number.isInteger(pk)) return null;
    const relative = this.reader.mediaPath(pk);
    return relative ? this.resolveMedia(relative) : null;
  }

  private resolveMedia(relative: string): string | null {
    const root = normalize(this.options.containerDir) + sep;
    for (const candidate of [
      join(this.options.containerDir, 'Message', relative),
      join(this.options.containerDir, relative),
    ]) {
      const full = normalize(candidate);
      // Never serve anything outside WhatsApp's own folders.
      if (!full.startsWith(root)) continue;
      try {
        const stats = statSync(full);
        // An iCloud-style "dataless" placeholder has no blocks on disk and blocks
        // whoever reads it until it downloads. Treat it as not downloaded.
        if (stats.isFile() && !(stats.size > 0 && stats.blocks === 0)) return full;
      } catch {
        // Not downloaded.
      }
    }
    return null;
  }

  private reset(): void {
    // Start always reads everything again: the store may have been recreated
    // (signed out and linked again), and re-reading unchanged rows is free.
    this.lastPk = 0;
    this.lastVersion = -1;
    this.recent.clear();
    this.chatState.clear();
    this.sessions = new Map();
    this.rescan.clear();
    this.folded = [];
  }

  private open(path: string): DatabaseSync {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
    db.exec('PRAGMA query_only = 1');
    return db;
  }

  /**
   * One short read transaction: a consistent snapshot without holding a
   * transaction open between polls, which would stop WhatsApp checkpointing.
   */
  private read<T>(fn: () => T): T {
    this.db!.exec('BEGIN');
    try {
      return fn();
    } finally {
      this.db?.exec('COMMIT');
    }
  }

  private close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = undefined;
    this.reader = undefined;
  }

  /** Changes whenever WhatsApp writes its contact databases (WAL files included). */
  private stampContacts(): string {
    return CONTACT_FILES.flatMap((name) => [name, `${name}-wal`])
      .map((name) => {
        try {
          const stats = statSync(join(this.options.containerDir, name));
          return `${stats.mtimeMs}:${stats.size}`;
        } catch {
          return '-';
        }
      })
      .join('|');
  }

  private loadContacts(): ContactBook {
    const openOptional = (name: string) => {
      const path = join(this.options.containerDir, name);
      if (!existsSync(path)) return undefined;
      try {
        return this.open(path);
      } catch (err) {
        this.ctx?.log('warn', `Could not read ${name}; names will come from WhatsApp profiles`, err);
        return undefined;
      }
    };
    const [contacts, lid] = CONTACT_FILES.map(openOptional);
    try {
      return readContactBook(contacts, lid);
    } catch (err) {
      this.ctx?.log('warn', 'Could not read contact names', err);
      return new ContactBook();
    } finally {
      contacts?.close();
      lid?.close();
    }
  }

  /** Reload names and LID mappings when WhatsApp has written them; queue groups whose senders changed id. */
  private refreshContacts(): boolean {
    const stamp = this.stampContacts();
    if (stamp === this.contactsStamp) return false;
    this.contactsStamp = stamp;
    const before = this.contacts.lidToPhone;
    this.contacts = this.loadContacts();
    const remapped = new Set(
      [...this.contacts.lidToPhone].filter(([lid, phone]) => before.get(lid) !== phone).map(([lid]) => lid),
    );
    this.reader!.setContacts(this.contacts);
    // Group messages from these people were stored under their LID.
    if (remapped.size && this.lastPk > 0) for (const pk of this.reader!.groupsWith(remapped)) this.rescan.add(pk);
    return true;
  }

  private async poll(session: number): Promise<void> {
    if (!this.reader || this.syncing || session !== this.session) return;
    try {
      const contactsChanged = this.refreshContacts();
      if (!contactsChanged && this.reader.dataVersion() === this.lastVersion) return;
      this.running = this.sync(session, false);
      await this.running;
    } catch (err) {
      this.ctx?.log('warn', 'Poll failed', err);
    }
  }

  private async sync(session: number, backfill: boolean): Promise<void> {
    const ctx = this.ctx!;
    const reader = this.reader!;
    const live = () => session === this.session;
    this.syncing = true;
    try {
      // Read before anything else, so a commit during the sync triggers another one.
      this.lastVersion = reader.dataVersion();
      this.applySnapshot(this.read(() => reader.snapshot()));

      // New rows since last time, in batches. Rows that don't map still move the cursor on.
      let total = 0;
      for (;;) {
        const batch = this.read(() => reader.readMessages({ afterPk: this.lastPk, limit: BATCH }));
        if (batch.snapshot) this.applySnapshot(batch.snapshot);
        this.ingest(batch.rows);
        this.lastPk = batch.lastPk;
        total += batch.rows.length;
        if (batch.scanned < BATCH) break;
        if (backfill)
          ctx.setStatus({ state: 'starting', detail: `Reading history… ${total.toLocaleString()} messages` });
        await nextTick();
        if (!live()) return;
      }

      // Older rows of chats that just appeared or changed id.
      for (const chat of [...this.rescan]) {
        this.rescan.delete(chat);
        for (let afterPk = 0; ;) {
          const batch = this.read(() =>
            reader.readMessages({ afterPk, untilPk: this.lastPk, limit: BATCH, chats: [chat] }),
          );
          if (batch.snapshot) this.applySnapshot(batch.snapshot);
          this.ingest(batch.rows);
          afterPk = batch.lastPk;
          if (batch.scanned < BATCH) break;
          await nextTick();
          if (!live()) return;
        }
      }

      // Edits, deletes and reactions rewrite existing rows rather than adding new ones.
      const recent = this.read(() => reader.readRecentMessages(RECENT_WINDOW));
      if (recent.snapshot) this.applySnapshot(recent.snapshot);
      const changed: MessageRow[] = [];
      for (const row of recent.rows) {
        const before = this.recent.get(row.pk);
        if (before && sameState(before, row.state)) continue;
        // Rows seen for the first time (a chat that only now maps, say) go in as they are.
        const edited = !!before && !row.input.deleted && before.text !== null && before.text !== row.state.text;
        changed.push(edited ? { ...row, input: { ...row.input, edited: true } } : row);
      }
      if (changed.length) {
        // A changed ZSORT < 0 row is the message itself, unless a regular copy exists.
        const updates = this.read(() => changed.filter((row) => !row.duplicate || !reader.hasRegularCopy(row)));
        this.ingest(updates.map((row) => ({ ...row, duplicate: false })));
      }

      // Fold LID chats into their phone-number conversations once their rows have moved.
      for (const { from, into } of this.folded) ctx.retireConversation(from, into);
      this.folded = [];

      ctx.setStatus({
        state: 'connected',
        detail: `Watching ${this.sessions.size.toLocaleString()} chats · reply in WhatsApp`,
      });
    } catch (err) {
      if (!live()) return; // stopped mid-read
      const permission = isPermissionError(err);
      ctx.setStatus({
        state: permission ? 'needs_setup' : 'error',
        detail: permission ? PERMISSION_HELP : (err as Error).message,
      });
      ctx.log('error', 'Sync failed', err);
    } finally {
      if (live()) this.syncing = false;
    }
  }

  private applySnapshot(snapshot: ChatSnapshot): void {
    for (const chat of snapshot.chats) {
      const key = JSON.stringify(chat.input);
      if (this.chatState.get(chat.input.nativeId) === key) continue;
      this.chatState.set(chat.input.nativeId, key);
      this.ctx!.upsertConversation(chat.input);
    }
    // A chat that was hidden, or is now known by its phone number, has rows behind the cursor.
    if (this.lastPk > 0) {
      for (const [pk, jid] of snapshot.sessions) if (this.sessions.get(pk) !== jid) this.rescan.add(pk);
    }
    this.sessions = snapshot.sessions;
    this.folded = snapshot.folded;
  }

  private ingest(rows: MessageRow[]): void {
    if (rows.length === 0) return;
    const regular: MessageInput[] = [];
    const copies: MessageInput[] = [];
    for (const row of rows) {
      this.recent.set(row.pk, row.state);
      const file = row.mediaRef ? this.mediaFile(row.mediaRef.slice('media:'.length)) : null;
      const input = {
        ...row.input,
        attachments: (row.input.attachments ?? []).map((a) =>
          file && row.mediaRef ? { ...a, url: `/api/connectors/${this.id}/media/${row.mediaRef.slice(6)}` } : a,
        ),
      };
      (row.duplicate ? copies : regular).push(input);
    }
    this.ctx!.upsertMessages(regular, { countUnread: false, authoritative: true });
    // A ZSORT < 0 copy only fills a gap; it never overwrites the regular row.
    this.ctx!.upsertMessages(copies, { countUnread: false, onlyIfNew: true });
    // Only the recent window is re-checked, so older state can go.
    const cutoff = Math.max(this.lastPk, rows.at(-1)!.pk) - RECENT_WINDOW * 2;
    for (const pk of this.recent.keys()) if (pk < cutoff) this.recent.delete(pk);
  }
}
