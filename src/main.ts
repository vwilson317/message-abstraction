import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config';
import { WhatsAppConnector } from './connectors/whatsapp/connector';
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

hub.register(new WhatsAppConnector(config.whatsapp));

const app = createApp(hub, {
  allowedHosts: config.allowedHosts,
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
