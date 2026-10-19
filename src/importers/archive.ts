import { unzipSync } from 'fflate';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

/**
 * A read-only view over whatever the user handed us: one file, a zip, or an
 * extracted export folder. Paths always use forward slashes.
 */
export interface Archive {
  /** The file or folder name, used to guess chat titles. */
  name: string;
  paths: string[];
  size(path: string): number;
  readMany(paths: string[]): Map<string, Uint8Array>;
}

const textDecoder = new TextDecoder('utf-8');

export function readText(archive: Archive, path: string): string {
  const data = archive.readMany([path]).get(path);
  if (!data) throw new Error(`${path} not found in ${archive.name}`);
  return textDecoder.decode(data).replace(/^﻿/, '');
}

export function isZip(data: Uint8Array): boolean {
  return data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

export function archiveFromBuffer(name: string, data: Uint8Array): Archive {
  if (!isZip(data)) {
    return {
      name,
      paths: [name],
      size: () => data.byteLength,
      readMany: (paths) => new Map(paths.includes(name) ? [[name, data]] : []),
    };
  }
  const sizes = new Map<string, number>();
  // A filter that rejects everything lists the entries without inflating them.
  unzipSync(data, {
    filter: (file) => {
      if (!file.name.endsWith('/')) sizes.set(file.name, file.originalSize);
      return false;
    },
  });
  return {
    name,
    paths: [...sizes.keys()],
    size: (path) => sizes.get(path) ?? 0,
    readMany: (paths) => {
      const wanted = new Set(paths);
      return new Map(Object.entries(unzipSync(data, { filter: (file) => wanted.has(file.name) })));
    },
  };
}

export function archiveFromDirectory(dir: string): Archive {
  const sizes = new Map<string, number>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) sizes.set(relative(dir, full).split(sep).join('/'), statSync(full).size);
    }
  };
  walk(dir);
  return {
    name: basename(dir),
    paths: [...sizes.keys()],
    size: (path) => sizes.get(path) ?? 0,
    readMany: (paths) => new Map(paths.filter((p) => sizes.has(p)).map((p) => [p, readFileSync(join(dir, p))])),
  };
}
