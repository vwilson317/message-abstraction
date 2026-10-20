import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONTAINER as DEFAULT_WHATSAPP_CONTAINER } from './connectors/whatsapp-mac/connector';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  allowedHosts: string[];
  /** Pin which installed extension may push captures (chrome://extensions shows the id). */
  extensionIds: string[];
  maxUploadBytes: number;
  whatsappMac: {
    /** WhatsApp Desktop's group container; null when not on a Mac and not configured. */
    containerDir: string | null;
    pollMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Variables already set in the environment win over the file.
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');
  const host = env.HOST ?? '127.0.0.1';
  const extraHosts = (env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    port: Number(env.PORT ?? 4310),
    host,
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...(host === '0.0.0.0' ? [] : [host]), ...extraHosts],
    extensionIds: (env.EXTENSION_ID ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 512) * 1024 * 1024,
    whatsappMac: {
      containerDir: env.WHATSAPP_CONTAINER
        ? resolve(env.WHATSAPP_CONTAINER)
        : process.platform === 'darwin'
          ? DEFAULT_WHATSAPP_CONTAINER
          : null,
      pollMs: Number(env.WHATSAPP_POLL_MS ?? 1500),
    },
  };
}
