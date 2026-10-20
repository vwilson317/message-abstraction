import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config';
import { Hub } from '../core/hub';
import { MediaStore } from '../core/media';
import { archiveFromBuffer, archiveFromDirectory } from '../importers/archive';
import { importArchive, type ImportOptions } from '../importers/index';
import { Store } from '../store/db';

const USAGE = `Usage: npm run import -- <file-or-folder> [--self "Your Name"] [--date-order DMY|MDY|YMD]

Imports a WhatsApp chat export (.txt or .zip) or an Instagram "Download your
information" export (.zip or extracted folder, JSON format).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    self: { type: 'string' },
    'date-order': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const dateOrder = values['date-order']?.toUpperCase();
if (dateOrder && !['DMY', 'MDY', 'YMD'].includes(dateOrder)) {
  console.error(`--date-order must be DMY, MDY or YMD`);
  process.exit(1);
}

const target = resolve(positionals[0]!);
const archive = statSync(target).isDirectory()
  ? archiveFromDirectory(target)
  : archiveFromBuffer(target.split(/[\\/]/).pop()!, readFileSync(target));

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const store = new Store(join(config.dataDir, 'messages.db'));
const hub = new Hub(store, new MediaStore(join(config.dataDir, 'media')), config.dataDir);

const options: ImportOptions = {
  ...(values.self && { selfName: values.self }),
  ...(dateOrder && { dateOrder: dateOrder as ImportOptions['dateOrder'] }),
};

try {
  const summary = importArchive(hub, archive, options);
  for (const c of summary.conversations) {
    console.log(
      `✓ ${c.platform.padEnd(9)} ${c.title} — ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}${c.selfName ? ` (you: ${c.selfName})` : ''}`,
    );
  }
  for (const w of summary.warnings) console.warn(`! ${w}`);
  console.log('\nIf the server is running, reload the web UI to see imported chats.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
}
