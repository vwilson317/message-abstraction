import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { HubError, type Hub } from '../core/hub';
import { mimeForFile } from '../core/media';
import { archiveFromBuffer } from '../importers/archive';
import { importArchive, type ImportOptions } from '../importers/index';
import type { GroupAlerts, GroupChange } from '../core/groups';
import { computeGroupMetrics } from '../insights/groups';
import { computeStats } from '../insights/stats';
import { formatTranscript } from '../insights/transcript';

export interface AppOptions {
  /** Host names (without port) this server answers to. Guards against DNS rebinding. */
  allowedHosts: string[];
  /** Extension ids allowed to push captures; empty allows any chrome-extension:// origin. */
  extensionIds: string[];
  maxUploadBytes: number;
  /** Built web client to serve, if any. */
  staticDir?: string;
}

const SAFE_INLINE = /^(image\/(jpeg|png|gif|webp|heic)|video\/|audio\/)/;

/**
 * This server can read and send your messages, so it refuses requests that a
 * web page on another origin could trigger: unknown Host headers (DNS
 * rebinding) and cross-site writes (CSRF).
 */
const EXTENSION_ROUTE = /^\/api\/connectors\/[^/]+\/(captures|heartbeat)$/;

function localOnly(allowedHosts: string[], extensionIds: string[]): MiddlewareHandler {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const extensionAllowed = (origin: string) =>
    origin.startsWith('chrome-extension://') &&
    (extensionIds.length === 0 || extensionIds.includes(origin.slice('chrome-extension://'.length)));
  return async (c, next) => {
    const hostHeader = c.req.header('host') ?? '';
    const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
    if (!allowed.has(host)) return c.json({ error: `Host "${host}" is not allowed` }, 403);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      // Web pages can't claim a chrome-extension:// origin, so this doesn't reopen CSRF.
      const fromExtension = !!origin && extensionAllowed(origin) && EXTENSION_ROUTE.test(c.req.path);
      if (!fromExtension) {
        if (site && site !== 'same-origin' && site !== 'none') {
          return c.json({ error: 'Cross-site request refused' }, 403);
        }
        if (origin && origin !== 'null' && new URL(origin).host !== hostHeader) {
          return c.json({ error: 'Cross-origin request refused' }, 403);
        }
      }
    }
    await next();
  };
}

/**
 * A single `bytes=` range, clamped to the file. Null means serve the whole
 * file: no header, a malformed one, or several ranges (allowed by RFC 9110).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    // A suffix: the last N bytes.
    const length = Number(m[2]);
    return length === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return null; // invalid, so ignored
  if (start >= size) return 'unsatisfiable';
  return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

/**
 * Media can come from exports or another app's folders, so it's never trusted
 * to run, and other sites may not embed it. Files can be gigabytes (WhatsApp
 * videos and documents), so they're streamed, with byte ranges for seeking.
 */
async function mediaResponse(c: Context, path: string): Promise<Response> {
  // Connector media ids are small sequential numbers; don't let other sites probe them.
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'Cross-site request refused' }, 403);
  let size: number;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return c.json({ error: 'Not found' }, 404);
    size = stats.size;
  } catch {
    return c.json({ error: 'Not found' }, 404);
  }
  const type = mimeForFile(path) ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Disposition': SAFE_INLINE.test(type) ? 'inline' : 'attachment',
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  };
  const range = parseRange(c.req.header('range'), size);
  if (range === 'unsatisfiable') {
    return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${size}` });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = Math.max(0, end - start + 1);
  headers['Content-Length'] = String(length);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (c.req.method === 'HEAD' || length === 0) return c.body(null, status, headers);
  const stream = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream<Uint8Array>;
  return c.body(stream, status, headers);
}

/** Only this app and the extension's side panel may frame the UI (no clickjacking). */
function frameAncestors(extensionIds: string[]): string {
  const extensions = extensionIds.length
    ? extensionIds.map((id) => `chrome-extension://${id.replace(/[^a-z0-9]/gi, '')}`).join(' ')
    : 'chrome-extension:';
  return `frame-ancestors 'self' ${extensions}`;
}

function parseGroupChange(body: { group?: unknown; dateAt?: unknown }): GroupChange {
  if (body.group === 'dates') {
    if (typeof body.dateAt !== 'number' || !Number.isFinite(body.dateAt)) throw new HubError('A date needs "dateAt"');
    return { group: 'dates', dateAt: body.dateAt };
  }
  if (body.group === 'close' || body.group === 'romantic' || body.group === 'ghosts') return { group: body.group };
  throw new HubError(`Unknown group "${String(body.group)}"`);
}

async function jsonBody<T>(c: Context): Promise<Partial<T>> {
  if (!c.req.header('content-type')?.startsWith('application/json')) {
    throw new HubError('Expected a JSON body');
  }
  return (await c.req.json()) as Partial<T>;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HubError(`"${value}" is not a number`);
  return n;
}

export function createApp(hub: Hub, options: AppOptions): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HubError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: err.message || 'Internal error' }, 500);
  });
  app.use('*', localOnly(options.allowedHosts, options.extensionIds));

  const api = new Hono();

  api.get('/health', (c) => c.json({ ok: true }));

  // ── Connectors ──────────────────────────────────────────────────────────
  api.get('/connectors', (c) => c.json(hub.connectorStatuses()));
  api.post('/connectors/:id/connect', async (c) => {
    await hub.startConnector(c.req.param('id'));
    return c.json({ ok: true });
  });
  api.get('/connectors/:id/media/:ref', async (c) => {
    const path = hub.connectorMediaFile(c.req.param('id'), c.req.param('ref'));
    if (!path) return c.json({ error: 'Not found' }, 404);
    return mediaResponse(c, path);
  });
  // The browser extension pushes what it reads from a tab. Its requests carry a
  // chrome-extension:// origin, which localOnly() lets through for these two routes.
  api.post('/connectors/:id/captures', async (c) => {
    const body = await jsonBody<unknown>(c);
    return c.json(hub.receive(c.req.param('id'), body));
  });
  api.post('/connectors/:id/heartbeat', (c) => {
    hub.heartbeat(c.req.param('id'));
    return c.json({ ok: true });
  });
  api.post('/connectors/:id/disconnect', async (c) => {
    await hub.stopConnector(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Conversations ───────────────────────────────────────────────────────
  api.get('/conversations', (c) => c.json(hub.store.listConversations()));
  api.get('/conversations/:id', (c) => c.json(hub.requireConversation(c.req.param('id'))));
  api.patch('/conversations/:id', async (c) => {
    const body = await jsonBody<{ selfParticipantId: string | null; group: string; dateAt: number }>(c);
    const id = c.req.param('id');
    if (body.group !== undefined) return c.json(hub.setGroup(id, parseGroupChange(body)));
    if (body.selfParticipantId !== undefined) return c.json(hub.setSelf(id, body.selfParticipantId));
    throw new HubError('Nothing to update');
  });
  api.delete('/conversations/:id', (c) => {
    hub.deleteConversation(c.req.param('id'));
    return c.body(null, 204);
  });
  api.post('/conversations/:id/read', (c) => c.json(hub.markRead(c.req.param('id'))));

  api.get('/conversations/:id/messages', (c) => {
    const id = hub.requireConversation(c.req.param('id')).id;
    const before = c.req.query('before');
    const limit = optionalNumber(c.req.query('limit'));
    return c.json(hub.store.listMessages(id, { ...(before && { before }), ...(limit && { limit }) }));
  });
  // ── Insights ────────────────────────────────────────────────────────────
  api.get('/conversations/:id/insights', (c) => {
    const conversation = hub.requireConversation(c.req.param('id'));
    const messages = hub.store.allMessages(conversation.id);
    return c.json({
      ...computeStats(conversation, messages),
      groupMetrics: computeGroupMetrics(conversation, messages),
    });
  });

  // ── Settings ────────────────────────────────────────────────────────────
  api.get('/settings', (c) => c.json(hub.settings()));
  api.patch('/settings', async (c) => {
    const body = await jsonBody<{ groupAlerts: Partial<GroupAlerts> }>(c);
    if (body.groupAlerts !== undefined && (typeof body.groupAlerts !== 'object' || body.groupAlerts === null)) {
      throw new HubError('"groupAlerts" must be an object');
    }
    return c.json(hub.updateSettings({ ...(body.groupAlerts && { groupAlerts: body.groupAlerts }) }));
  });
  api.get('/conversations/:id/transcript', (c) => {
    const conversation = hub.requireConversation(c.req.param('id'));
    const from = optionalNumber(c.req.query('from'));
    const to = optionalNumber(c.req.query('to'));
    const last = optionalNumber(c.req.query('last'));
    const text = formatTranscript(conversation, hub.store.allMessages(conversation.id), {
      ...(from !== undefined && { from }),
      ...(to !== undefined && { to }),
      ...(last !== undefined && { last }),
    });
    if (c.req.query('download') !== undefined) {
      const name = conversation.title.replace(/[^\w\- ]+/g, '').trim() || 'conversation';
      c.header('Content-Disposition', `attachment; filename="${name}.txt"`);
    }
    return c.text(text);
  });

  // ── Import ──────────────────────────────────────────────────────────────
  api.post(
    '/import',
    bodyLimit({
      maxSize: options.maxUploadBytes,
      onError: (c) =>
        c.json({ error: 'File too large for upload. Use `npm run import -- <path>` for big exports.' }, 413),
    }),
    async (c) => {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw new HubError('Attach the export as "file"');
      const importOptions: ImportOptions = {};
      if (typeof form.selfName === 'string' && form.selfName.trim()) importOptions.selfName = form.selfName.trim();
      if (form.dateOrder === 'DMY' || form.dateOrder === 'MDY' || form.dateOrder === 'YMD') {
        importOptions.dateOrder = form.dateOrder;
      }
      const archive = archiveFromBuffer(file.name, new Uint8Array(await file.arrayBuffer()));
      try {
        return c.json(importArchive(hub, archive, importOptions));
      } catch (err) {
        if (err instanceof HubError) throw err;
        throw new HubError((err as Error).message);
      }
    },
  );

  // ── Media ───────────────────────────────────────────────────────────────
  api.get('/media/:file', async (c) => {
    const path = hub.media.resolve(c.req.param('file'));
    if (!path) return c.json({ error: 'Not found' }, 404);
    return mediaResponse(c, path);
  });

  // ── Live updates ────────────────────────────────────────────────────────
  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = hub.subscribe((event) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      stream.onAbort(unsubscribe);
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: 'ping', data: '' });
      }
      unsubscribe();
    }),
  );

  app.route('/api', api);

  if (options.staticDir && existsSync(options.staticDir)) {
    const framing = frameAncestors(options.extensionIds);
    app.use('/*', async (c, next) => {
      await next();
      if (c.res.headers.get('content-type')?.startsWith('text/html')) {
        c.res.headers.set('Content-Security-Policy', framing);
      }
    });
    // serveStatic resolves `root` against the working directory.
    const root = relative(process.cwd(), options.staticDir) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ path: join(root, 'index.html') }));
  }

  return app;
}
