// Bundles the Chrome extension into dist/extension, ready for "Load unpacked".
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const outdir = 'dist/extension';
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: {
    background: 'extension/src/background.ts',
    'content-instagram': 'extension/src/content/instagram.ts',
    sidepanel: 'extension/src/sidepanel.ts',
  },
  bundle: true,
  // Content scripts can't be modules; an IIFE works everywhere.
  format: 'iife',
  target: 'chrome116',
  outdir,
  logLevel: 'warning',
});

for (const file of readdirSync('extension/public')) copyFileSync(join('extension/public', file), join(outdir, file));

// Icons are drawn here (a rounded blue square with three lines) so the repo carries no binaries.
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function icon(size) {
  const radius = size * 0.22;
  const lines = [
    { y: 0.34, end: 0.75 },
    { y: 0.5, end: 0.62 },
    { y: 0.66, end: 0.5 },
  ];
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter byte
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x - 0.5, x + 0.5 - (size - radius), 0);
      const dy = Math.max(radius - y - 0.5, y + 0.5 - (size - radius), 0);
      const inside = dx * dx + dy * dy <= radius * radius;
      const u = x / size;
      const v = y / size;
      const onLine = lines.some((l) => Math.abs(v - l.y) < 0.045 && u > 0.25 && u < l.end);
      row.push(...(inside ? (onLine ? [255, 255, 255, 255] : [42, 120, 214, 255]) : [0, 0, 0, 0]));
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(join(outdir, `icon-${size}.png`), icon(size));

console.log(`Extension built in ${outdir}. Load it from chrome://extensions → Developer mode → Load unpacked.`);
