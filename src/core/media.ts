import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.3gp': 'video/3gpp',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.vcf': 'text/vcard',
};

const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]));

export function mimeForFile(name: string): string | undefined {
  return MIME_BY_EXT[extname(name).toLowerCase()];
}

/** Content-addressed media files, served at /api/media/<file>. */
export class MediaStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Save bytes and return the URL the web client can load them from. */
  save(data: Uint8Array, hint: { fileName?: string; mimeType?: string } = {}): string {
    const fromName = hint.fileName ? extname(hint.fileName).toLowerCase() : '';
    const fromMime = hint.mimeType ? EXT_BY_MIME[hint.mimeType.split(';')[0]!.trim()] : undefined;
    const ext = /^\.[a-z0-9]{1,5}$/.test(fromName) ? fromName : (fromMime ?? '.bin');
    const file = createHash('sha256').update(data).digest('hex').slice(0, 32) + ext;
    const path = join(this.dir, file);
    if (!existsSync(path)) writeFileSync(path, data);
    return `/api/media/${file}`;
  }

  /** Resolve a file name from a URL path, refusing anything that isn't one of ours. */
  resolve(file: string): string | undefined {
    if (!/^[a-f0-9]{32}\.[a-z0-9]{1,5}$/.test(file)) return undefined;
    const path = join(this.dir, file);
    return existsSync(path) ? path : undefined;
  }
}
