import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { Hub } from '../src/core/hub';
import { MediaStore } from '../src/core/media';
import type { HubEvent } from '../src/core/types';
import { Store } from '../src/store/db';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

export function makeHub() {
  const dir = mkdtempSync(join(tmpdir(), 'msgabs-'));
  const store = new Store(join(dir, 'test.db'));
  const media = new MediaStore(join(dir, 'media'));
  const hub = new Hub(store, media, dir);
  const events: HubEvent[] = [];
  hub.subscribe((e) => events.push(e));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { hub, store, media, events, dir };
}
