import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config';
import { BrowserSource } from './connectors/browser/source';
import { signatureOf } from './connectors/browser/align';
import { WhatsAppMacConnector } from './connectors/whatsapp-mac/connector';
import { Hub } from './core/hub';
import { MediaStore } from './core/media';
import { createApp } from './server/app';
import { Store } from './store/db';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const store = new Store(join(config.dataDir, 'messages.db'));
const media = new MediaStore(join(config.dataDir, 'media'));
const hub = new Hub(store, media, config.dataDir, (level, message, extra) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line, extra ?? '');
  else if (level === 'warn') console.warn(line, extra ?? '');
  else console.log(line);
});

if (config.whatsappMac.containerDir) {
  hub.register(
    new WhatsAppMacConnector({ containerDir: config.whatsappMac.containerDir, pollMs: config.whatsappMac.pollMs }),
  );
}

hub.register(
  new BrowserSource(
    'instagram-web',
    'instagram',
    'Instagram (Chrome)',
    'Open instagram.com/direct in Chrome with the Inbox extension installed.',
    (conversationId) =>
      store
        .messagesBetween(conversationId, 0, Number.MAX_SAFE_INTEGER, 50_000)
        .map((m) => ({ nativeId: m.nativeId, signature: signatureOf(m), timestamp: m.timestamp })),
  ),
);

const app = createApp(hub, {
  allowedHosts: config.allowedHosts,
  extensionIds: config.extensionIds,
  maxUploadBytes: config.maxUploadBytes,
  ...(process.env.NODE_ENV === 'production' && { staticDir: resolve('dist/web') }),
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, ({ port }) => {
  console.log(`message-abstraction API on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
  if (process.env.NODE_ENV !== 'production') console.log('Web UI (dev): http://localhost:5173');
});

hub.autoStart().catch((err) => console.error('Failed to start connectors', err));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await hub.stopAll();
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
