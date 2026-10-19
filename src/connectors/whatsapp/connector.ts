import type { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  isJidGroup,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type Contact,
  type WAMessage,
  type WASocket,
  type proto,
} from 'baileys';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import type { Connector, ConnectorContext, MessageInput, MessagePatch } from '../../core/connector';
import {
  canonicalJid,
  chatJidOf,
  downloadableMedia,
  isIgnoredJid,
  normalizeMessage,
  normalizeUpdate,
  phoneLabel,
  type JidResolver,
} from './normalize';

export interface WhatsAppOptions {
  /** Ask the phone for as much history as it will give when linking. */
  syncFullHistory: boolean;
  /** Auto-download images, stickers and voice notes up to this size for live messages. */
  autoDownloadMaxBytes: number;
}

/** How confident we are in a chat title, so a phone number never overwrites a saved contact name. */
const enum TitleRank {
  Phone = 0,
  PushName = 1,
  Saved = 2,
}

const SENT_CACHE_LIMIT = 500;
const MAX_UNPAIRED_RETRIES = 3;

/**
 * Personal WhatsApp via Baileys, which links as a WhatsApp Web device.
 * This is an unofficial client: see docs/ARCHITECTURE.md for the trade-offs.
 */
export class WhatsAppConnector implements Connector {
  readonly id = 'whatsapp';
  readonly platform = 'whatsapp' as const;
  readonly label = 'WhatsApp';
  readonly capabilities = { send: true, liveUpdates: true };

  private ctx?: ConnectorContext;
  private sock?: WASocket;
  private stopping = false;
  private retries = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private selfJid: string | null = null;
  /** "Linked as …", set once the connection is open. */
  private linkedAs: string | null = null;
  private readonly contacts = new Map<string, Contact>();
  private readonly lidMap = new Map<string, string>();
  private readonly titles = new Map<string, { title: string; rank: TitleRank }>();
  /** Recently sent message bodies, so WhatsApp's retry requests can be answered. */
  private readonly sent = new Map<string, proto.IMessage>();

  private readonly resolver: JidResolver;

  constructor(private readonly options: WhatsAppOptions) {
    const connector = this;
    this.resolver = {
      get selfJid() {
        return connector.selfJid;
      },
      lidToPn: (lid) => this.lidMap.get(lid),
      nameFor: (jid) => {
        const c = this.contacts.get(jid);
        return c?.name || c?.notify || c?.verifiedName || undefined;
      },
    };
  }

  private authDir(dataDir: string): string {
    return join(dataDir, 'auth');
  }

  async hasSession(dataDir: string): Promise<boolean> {
    return existsSync(join(this.authDir(dataDir), 'creds.json'));
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
    this.stopping = false;
    this.retries = 0;
    ctx.setStatus({ state: 'starting' });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    sock?.end(undefined);
  }

  async logout(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    try {
      await this.sock?.logout();
    } catch {
      // Already disconnected; deleting credentials below is what matters.
    }
    this.sock?.end(undefined);
    this.sock = undefined;
    if (this.ctx) await rm(this.authDir(this.ctx.dataDir), { recursive: true, force: true });
  }

  async sendText(conversationNativeId: string, text: string): Promise<MessageInput> {
    if (!this.sock) throw new Error('WhatsApp is not connected');
    const sent = await this.sock.sendMessage(conversationNativeId, { text });
    if (!sent?.key.id) throw new Error('WhatsApp did not return the sent message');
    this.rememberSent(sent);
    const normalized = normalizeMessage(sent, this.resolver);
    if (normalized?.type !== 'message') throw new Error('Could not read back the sent message');
    return { ...normalized.input, conversationNativeId, status: normalized.input.status ?? 'sent' };
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  private async connect(): Promise<void> {
    const ctx = this.ctx!;
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir(ctx.dataDir));
    const logger = pino({ level: process.env.WHATSAPP_LOG_LEVEL ?? 'silent' });
    const latest = await fetchLatestWaWebVersion().catch(() => undefined);

    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      ...(latest && { version: latest.version }),
      logger,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: this.options.syncFullHistory,
      markOnlineOnConnect: false,
      shouldIgnoreJid: (jid) => isIgnoredJid(jid),
      getMessage: async (key) => (key.id ? this.sent.get(key.id) : undefined),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (sock !== this.sock) return;
      if (update.qr) {
        const qr = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 });
        ctx.setStatus({
          state: 'awaiting_auth',
          qr,
          detail: 'Open WhatsApp → Settings → Linked devices → Link a device',
        });
      }
      if (update.connection === 'open') {
        this.retries = 0;
        this.selfJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
        const who = sock.user?.name ?? (this.selfJid ? phoneLabel(this.selfJid) : 'unknown');
        this.linkedAs = `Linked as ${who}`;
        ctx.setStatus({ state: 'connected', detail: this.linkedAs });
        void this.loadGroups(sock);
      }
      if (update.connection === 'close') {
        this.onClose(update.lastDisconnect?.error as Boom | undefined, state.creds.registered ?? false);
      }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings, progress }) => {
      for (const m of lidPnMappings ?? []) this.lidMap.set(m.lid, m.pn);
      this.rememberContacts(contacts);
      for (const chat of chats) {
        if (!chat.id || isIgnoredJid(chat.id)) continue;
        const jid = canonicalJid(chat.id, chat.pnJid, this.resolver);
        if (chat.name) this.setTitle(jid, chat.name, TitleRank.Saved, isJidGroup(jid));
        else this.ensureChat(jid);
      }
      this.ingest(messages, false);
      if (this.linkedAs && progress != null) {
        const detail = progress < 100 ? `Syncing history… ${Math.round(progress)}%` : this.linkedAs;
        ctx.setStatus({ state: 'connected', detail });
      }
    });

    sock.ev.on('lid-mapping.update', (m) => this.lidMap.set(m.lid, m.pn));
    sock.ev.on('contacts.upsert', (contacts) => this.rememberContacts(contacts));
    sock.ev.on('contacts.update', (contacts) => this.rememberContacts(contacts.filter((c): c is Contact => !!c.id)));

    sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) {
        if (!chat.id || !chat.name || isIgnoredJid(chat.id)) continue;
        this.setTitle(
          canonicalJid(chat.id, chat.pnJid, this.resolver),
          chat.name,
          TitleRank.Saved,
          isJidGroup(chat.id),
        );
      }
    });

    sock.ev.on('groups.upsert', (groups) => {
      for (const g of groups) if (g.subject) this.setTitle(g.id, g.subject, TitleRank.Saved, true);
    });
    sock.ev.on('groups.update', (groups) => {
      for (const g of groups) if (g.id && g.subject) this.setTitle(g.id, g.subject, TitleRank.Saved, true);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => this.ingest(messages, type === 'notify'));

    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        for (const patch of normalizeUpdate(key, update, this.resolver)) ctx.patchMessage(patch);
      }
    });

    sock.ev.on('messages.reaction', (reactions) => {
      for (const { key, reaction } of reactions) {
        const normalized = normalizeMessage(
          { key: reaction.key ?? key, message: { reactionMessage: { key, text: reaction.text ?? '' } } },
          this.resolver,
        );
        if (normalized?.type === 'patch') ctx.patchMessage(normalized.patch);
      }
    });
  }

  private onClose(error: Boom | undefined, registered: boolean): void {
    const ctx = this.ctx!;
    this.sock = undefined;
    this.linkedAs = null;
    if (this.stopping) return;
    const code = error?.output?.statusCode;

    if (code === DisconnectReason.loggedOut) {
      void rm(this.authDir(ctx.dataDir), { recursive: true, force: true });
      ctx.setStatus({ state: 'stopped', detail: 'This device was unlinked from your phone' });
      return;
    }
    if (!registered && code === DisconnectReason.timedOut) {
      ctx.setStatus({ state: 'stopped', detail: 'The QR code expired. Connect again to get a new one.' });
      return;
    }
    // A linked device should ride out outages, but a first connection that keeps
    // failing (no network, blocked IP) should say so rather than spin forever.
    if (!registered && code !== DisconnectReason.restartRequired && this.retries >= MAX_UNPAIRED_RETRIES) {
      ctx.setStatus({ state: 'error', detail: `Couldn't reach WhatsApp: ${error?.message ?? 'connection closed'}` });
      return;
    }
    // 515 is expected right after pairing; reconnect at once. Otherwise back off.
    const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 1000 * 2 ** this.retries++);
    ctx.setStatus({ state: 'reconnecting', detail: error?.message ?? 'Connection closed' });
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err: Error) => ctx.setStatus({ state: 'error', detail: err.message }));
    }, delay);
  }

  // ── Normalisation into the hub ────────────────────────────────────────────

  private ingest(messages: WAMessage[], live: boolean): void {
    const ctx = this.ctx!;
    const inputs: MessageInput[] = [];
    const patches: MessagePatch[] = [];
    for (const msg of messages) {
      const normalized = normalizeMessage(msg, this.resolver);
      if (!normalized) continue;
      if (normalized.type === 'patch') {
        patches.push(normalized.patch);
        continue;
      }
      const { input } = normalized;
      if (input.fromSelf && msg.message) this.rememberSent(msg);
      // In 1:1 chats the sender's push name is a decent title until a saved name turns up.
      if (!input.fromSelf && msg.pushName && !isJidGroup(input.conversationNativeId)) {
        this.setTitle(input.conversationNativeId, msg.pushName, TitleRank.PushName, false);
      }
      this.ensureChat(input.conversationNativeId);
      inputs.push(input);
    }
    ctx.upsertMessages(inputs, { countUnread: live });
    for (const patch of patches) ctx.patchMessage(patch);
    if (live) for (const msg of messages) void this.downloadMedia(msg);
  }

  private async downloadMedia(msg: WAMessage): Promise<void> {
    const ctx = this.ctx!;
    const media = downloadableMedia(msg, this.options.autoDownloadMaxBytes);
    const normalized = media && normalizeMessage(msg, this.resolver);
    if (!media || normalized?.type !== 'message' || !this.sock) return;
    try {
      const data = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: pino({ level: 'silent' }),
          reuploadRequest: this.sock.updateMediaMessage,
        },
      );
      const url = ctx.saveMedia(data, media);
      const attachments = (normalized.input.attachments ?? []).map((a) => ({ ...a, url }));
      ctx.patchMessage({
        conversationNativeId: normalized.input.conversationNativeId,
        nativeId: normalized.input.nativeId,
        attachments,
      });
    } catch (err) {
      ctx.log('warn', 'Media download failed', err);
    }
  }

  private async loadGroups(sock: WASocket): Promise<void> {
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const g of Object.values(groups)) {
        const participants = g.participants.map((p) => {
          const id = canonicalJid(p.id, p.phoneNumber, this.resolver);
          return { id, name: this.resolver.nameFor(id) ?? phoneLabel(id), isSelf: id === this.selfJid };
        });
        this.ctx!.upsertConversation({
          platform: 'whatsapp',
          nativeId: g.id,
          title: g.subject,
          isGroup: true,
          participants,
        });
        this.titles.set(g.id, { title: g.subject, rank: TitleRank.Saved });
      }
    } catch (err) {
      this.ctx!.log('warn', 'Could not load groups', err);
    }
  }

  private rememberContacts(contacts: Contact[]): void {
    for (const c of contacts) {
      if (c.lid && c.phoneNumber) this.lidMap.set(jidNormalizedUser(c.lid), jidNormalizedUser(c.phoneNumber));
      const jid = isLidUser(c.id) && c.phoneNumber ? jidNormalizedUser(c.phoneNumber) : jidNormalizedUser(c.id);
      const merged = { ...this.contacts.get(jid), ...c, id: jid };
      this.contacts.set(jid, merged);
      // Only rename chats we already show; the address book itself isn't a chat list.
      if (merged.name && this.titles.has(jid)) this.setTitle(jid, merged.name, TitleRank.Saved, false);
    }
  }

  /** Make sure a chat exists with at least a phone-number title. */
  private ensureChat(jid: string): void {
    if (this.titles.has(jid)) return;
    const name = this.resolver.nameFor(jid);
    if (name) this.setTitle(jid, name, TitleRank.Saved, isJidGroup(jid));
    else this.setTitle(jid, isJidGroup(jid) ? 'Group' : phoneLabel(jid), TitleRank.Phone, isJidGroup(jid));
  }

  private setTitle(jid: string, title: string, rank: TitleRank, isGroup: boolean | undefined): void {
    const current = this.titles.get(jid);
    if (current && (current.rank > rank || (current.rank === rank && current.title === title))) return;
    this.titles.set(jid, { title, rank });
    const participants = isGroup
      ? undefined
      : [
          { id: jid, name: title, isSelf: false },
          ...(this.selfJid ? [{ id: this.selfJid, name: 'You', isSelf: true }] : []),
        ];
    this.ctx!.upsertConversation({
      platform: 'whatsapp',
      nativeId: jid,
      title,
      ...(isGroup !== undefined && { isGroup }),
      ...(participants && { participants }),
    });
  }

  private rememberSent(msg: WAMessage): void {
    if (!msg.key.id || !msg.message) return;
    this.sent.set(msg.key.id, msg.message);
    if (this.sent.size > SENT_CACHE_LIMIT) this.sent.delete(this.sent.keys().next().value!);
  }
}
