import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  allowedHosts: string[];
  maxUploadBytes: number;
  whatsapp: {
    syncFullHistory: boolean;
    autoDownloadMaxBytes: number;
  };
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
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
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 512) * 1024 * 1024,
    whatsapp: {
      syncFullHistory: flag(env.WHATSAPP_SYNC_FULL_HISTORY, true),
      autoDownloadMaxBytes: Number(env.WHATSAPP_AUTO_DOWNLOAD_MB ?? 16) * 1024 * 1024,
    },
  };
}
