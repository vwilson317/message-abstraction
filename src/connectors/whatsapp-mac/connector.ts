import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Connector, ConnectorContext, MessageInput } from '../../core/connector';
import { ChatStorageReader, ContactBook, readContactBook, type MessageRow } from './reader';

type RowState = MessageRow['state'];

function sameState(a: RowState, b: RowState): boolean {
  return a.type === b.type && a.text === b.text && a.media === b.media;
}

export const DEFAULT_CONTAINER = join(homedir(), 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared');

/** Opens the Full Disk Access pane in System Settings. */
export const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

export interface WhatsAppMacOptions {
  /** WhatsApp's shared group container, holding ChatStorage.sqlite and Message/. */
  containerDir: string;
  pollMs: number;
}

/** Rows read per batch during the first sync, so a large history doesn't block the server. */
const BACKFILL_BATCH = 2000;
/** How far back to look for edits and deletes on each change. */
const RECENT_WINDOW = 300;

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
  private lastPk = 0;
  private lastVersion = -1;
  private syncing = false;
  /** Last-seen state of recent rows, to spot edits and deletes (which rewrite rows in place). */
  private readonly recent = new Map<number, RowState>();
  private readonly chatState = new Map<string, string>();

  constructor(private readonly options: WhatsAppMacOptions) {}

  get dbPath(): string {
    return join(this.options.containerDir, 'ChatStorage.sqlite');
  }

  async shouldAutoStart(): Promise<boolean> {
    return existsSync(this.dbPath);
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
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
      this.reader = new ChatStorageReader(this.db, this.loadContacts());
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

    await this.sync({ backfill: true });
    if (this.reader) this.timer = setInterval(() => void this.poll(), this.options.pollMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.close();
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
    const contacts = openOptional('ContactsV2.sqlite');
    const lid = openOptional('LID.sqlite');
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

  private async poll(): Promise<void> {
    if (!this.reader || this.syncing) return;
    try {
      if (this.reader.dataVersion() === this.lastVersion) return;
      await this.sync({ backfill: false });
    } catch (err) {
      this.ctx?.log('warn', 'Poll failed', err);
    }
  }

  private async sync({ backfill }: { backfill: boolean }): Promise<void> {
    const ctx = this.ctx!;
    const reader = this.reader!;
    this.syncing = true;
    try {
      this.lastVersion = reader.dataVersion();
      const { chats, members } = this.read(() => ({ chats: reader.readChats(), members: reader.readGroupMembers() }));
      for (const chat of chats) {
        const participants = members.get(chat.input.nativeId);
        const input = participants
          ? { ...chat.input, participants: [...participants, ...(chat.input.participants ?? [])] }
          : chat.input;
        const key = JSON.stringify(input);
        if (this.chatState.get(chat.input.nativeId) === key) continue;
        this.chatState.set(chat.input.nativeId, key);
        ctx.upsertConversation(input);
      }

      // New rows since last time, in batches.
      let total = 0;
      for (;;) {
        const batch = this.read(() => reader.readMessagesAfter(this.lastPk, BACKFILL_BATCH));
        if (batch.length === 0) break;
        this.ingest(batch);
        this.lastPk = batch.at(-1)!.pk;
        total += batch.length;
        if (backfill) {
          ctx.setStatus({ state: 'starting', detail: `Reading history… ${total.toLocaleString()} messages` });
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (batch.length < BACKFILL_BATCH) break;
      }
      // Skipped rows (status updates, group events) can sit past the last mapped row.
      this.lastPk = Math.max(
        this.lastPk,
        this.read(() => reader.maxMessagePk()),
      );

      // Edits and deletes rewrite existing rows rather than adding new ones.
      const changed: MessageRow[] = [];
      for (const row of this.read(() => reader.readRecentMessages(RECENT_WINDOW))) {
        const before = this.recent.get(row.pk);
        if (!before || sameState(before, row.state)) continue;
        const edited = !row.input.deleted && before.text !== null && before.text !== row.state.text;
        changed.push(edited ? { ...row, input: { ...row.input, edited: true } } : row);
      }
      if (changed.length) this.ingest(changed);

      ctx.setStatus({
        state: 'connected',
        detail: `Watching ${chats.length.toLocaleString()} chats · reply in WhatsApp`,
      });
    } catch (err) {
      const permission = isPermissionError(err);
      ctx.setStatus({
        state: permission ? 'needs_setup' : 'error',
        detail: permission ? PERMISSION_HELP : (err as Error).message,
      });
      ctx.log('error', 'Sync failed', err);
    } finally {
      this.syncing = false;
    }
  }

  private ingest(rows: MessageRow[]): void {
    // History sync can leave a lower-priority copy of a message; never let it replace the primary.
    const primary = new Set(
      rows.filter((r) => !r.duplicate).map((r) => `${r.input.conversationNativeId}\0${r.input.nativeId}`),
    );
    const inputs: MessageInput[] = [];
    for (const row of rows) {
      this.recent.set(row.pk, row.state);
      if (row.duplicate && primary.has(`${row.input.conversationNativeId}\0${row.input.nativeId}`)) continue;
      const file = row.mediaRef ? this.mediaFile(row.mediaRef.slice('media:'.length)) : null;
      inputs.push({
        ...row.input,
        attachments: (row.input.attachments ?? []).map((a) =>
          file && row.mediaRef ? { ...a, url: `/api/connectors/${this.id}/media/${row.mediaRef.slice(6)}` } : a,
        ),
      });
    }
    this.ctx!.upsertMessages(inputs, { countUnread: false });
    // Only the recent window is re-checked, so older state can go.
    const cutoff = Math.max(this.lastPk, rows.at(-1)?.pk ?? 0) - RECENT_WINDOW * 2;
    for (const pk of this.recent.keys()) if (pk < cutoff) this.recent.delete(pk);
  }
}
