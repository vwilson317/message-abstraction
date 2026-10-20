import { createHash } from 'node:crypto';
import type { CapturedMessage } from './source';

/** What alignment needs to know about an already-stored message. */
export interface StoredItem {
  nativeId: string;
  signature: string;
  timestamp: number;
}

export interface AlignedMessage {
  message: CapturedMessage;
  nativeId: string;
  timestamp: number;
  isNew: boolean;
}

/**
 * Identity of a message as it looks on screen, used when the page gives no ids.
 * Direction rather than sender name: names are inferred from avatars that come
 * and go as the page scrolls, so they'd make the same message look different.
 */
export function signatureOf(m: { fromSelf: boolean; text: string | null; attachments?: { type: string }[] }): string {
  const who = m.fromSelf ? 'me' : 'in';
  const files = (m.attachments ?? []).map((a) => a.type).join(',');
  return `${who}\u0000${m.text ?? ''}\u0000${files}`;
}

/**
 * Longest common subsequence of two signature lists, as index pairs. A capture
 * is a contiguous on-screen slice; matching it against the stored sequence
 * this way finds where it sits even when short messages ("ok", "haha") repeat.
 */
export function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        a[i] === b[j] ? table[at(i + 1, j + 1)]! + 1 : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) i++;
    else j++;
  }
  return pairs;
}

function newId(anchor: string, signature: string, offset: number): string {
  return 'c' + createHash('sha1').update(`${anchor}\0${signature}\0${offset}`).digest('hex').slice(0, 20);
}

/**
 * Decide which captured messages are already stored and which are new, and
 * give every one an id and a timestamp that keeps the thread's order.
 *
 * - Messages carrying a page id are matched by id.
 * - The rest are matched by signature with an LCS against the stored tail.
 * - New messages get an id derived from the stored message before them, and
 *   a timestamp from the page if it had one, clamped between their stored
 *   neighbours; otherwise interpolated, or "now" for the newest ones.
 */
export function alignCapture(captured: CapturedMessage[], stored: StoredItem[], now = Date.now()): AlignedMessage[] {
  const storedById = new Map(stored.map((s) => [s.nativeId, s]));
  const signatures = captured.map((m) => signatureOf(m));

  // Index of the stored item each captured message corresponds to, if any.
  const match: (number | null)[] = captured.map((m) => {
    if (!m.id) return null;
    const hit = storedById.get(m.id);
    return hit ? stored.indexOf(hit) : null;
  });
  const unmatched = captured.map((_, i) => i).filter((i) => match[i] === null && !captured[i]!.id);
  if (unmatched.length) {
    const pairs = lcsPairs(
      unmatched.map((i) => signatures[i]!),
      stored.map((s) => s.signature),
    );
    for (const [ci, si] of pairs) match[unmatched[ci]!] = si;
  }

  // Ids: stored ones are reused; new ones derive from the stored message before them.
  const ids: string[] = [];
  let anchor = 'start';
  let offset = 0;
  for (let i = 0; i < captured.length; i++) {
    const si = match[i];
    if (si !== null && si !== undefined) {
      anchor = stored[si]!.nativeId;
      offset = 0;
      ids.push(anchor);
    } else {
      ids.push(captured[i]!.id ?? newId(anchor, signatures[i]!, offset++));
    }
  }

  // Timestamps: stored ones are kept; the page's own are used next; gaps are interpolated.
  const known: (number | null)[] = captured.map((m, i) => {
    const si = match[i];
    return si !== null && si !== undefined ? stored[si]!.timestamp : (m.timestamp ?? null);
  });
  const times: number[] = [];
  for (let i = 0; i < captured.length;) {
    if (known[i] !== null) {
      times.push(known[i]!);
      i++;
      continue;
    }
    let end = i;
    while (end < captured.length && known[end] === null) end++;
    const before = i > 0 ? times[i - 1]! : null;
    const after = end < captured.length ? known[end]! : null;
    const count = end - i;
    for (let k = 0; k < count; k++) {
      if (before !== null && after !== null) times.push(before + ((after - before) * (k + 1)) / (count + 1));
      else if (after !== null) times.push(after - (count - k) * 1000);
      else if (before !== null) times.push(Math.max(before + 1 + k, now - (count - 1 - k)));
      else times.push(now - (count - 1 - k));
    }
    i = end;
  }

  // Keep the capture strictly increasing so display order survives sorting by time.
  const result: AlignedMessage[] = [];
  let lastTs = -Infinity;
  for (let i = 0; i < captured.length; i++) {
    const isStored = match[i] !== null && match[i] !== undefined;
    let ts = Math.round(times[i]!);
    if (!isStored && ts <= lastTs) ts = lastTs + 1;
    result.push({ message: captured[i]!, nativeId: ids[i]!, timestamp: ts, isNew: !storedById.has(ids[i]!) });
    lastTs = Math.max(lastTs, ts);
  }
  return result;
}
