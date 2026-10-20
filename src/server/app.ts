import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { HubError, type Hub } from '../core/hub';
import { mimeForFile } from '../core/media';
import { archiveFromBuffer } from '../importers/archive';
import { importArchive, type ImportOptions } from '../importers/index';
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

/** Media can come from exports or another app's folders, so it's never trusted to run. */
async function mediaResponse(c: Context, path: string): Promise<Response> {
  const type = mimeForFile(path) ?? 'application/octet-stream';
  return c.body(await readFile(path), 200, {
    'Content-Type': type,
    'Content-Disposition': SAFE_INLINE.test(type) ? 'inline' : 'attachment',
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
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
    const body = await jsonBody<{ selfParticipantId: string | null }>(c);
    if (body.selfParticipantId === undefined) throw new HubError('Nothing to update');
    return c.json(hub.setSelf(c.req.param('id'), body.selfParticipantId));
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
    return c.json(computeStats(conversation, hub.store.allMessages(conversation.id)));
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
    // Only this app and the extension's side panel may frame the UI (no clickjacking).
    app.use('/*', async (c, next) => {
      await next();
      if (c.res.headers.get('content-type')?.startsWith('text/html')) {
        c.res.headers.set('Content-Security-Policy', "frame-ancestors 'self' chrome-extension:");
      }
    });
    // serveStatic resolves `root` against the working directory.
    const root = relative(process.cwd(), options.staticDir) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ path: join(root, 'index.html') }));
  }

  return app;
}
