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
  /** A stored message whose text changed on screen. */
  edited: boolean;
}

export type AlignResult = { messages: AlignedMessage[] } | { skipped: string };

export interface AlignOptions {
  now?: number;
  /** The window reaches the newest message in the thread. Undefined when the page didn't say. */
  atBottom?: boolean;
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

const directionOf = (signature: string) => signature.slice(0, 2);
const textOf = (signature: string) => signature.split('\u0000')[1] ?? '';

/**
 * Spacing for messages the page gives the same time (everything under one
 * divider). Well under a second, so insights never read it as a reply time.
 */
const STEP_MS = 100;
/** A window must line up with stored messages on at least this many exact matches to be placed. */
const MIN_ANCHOR = 2;
/** Bound on the alignment table; longer histories align against their newest part. */
const MAX_CELLS = 4_000_000;

// Local alignment scores. A stored message missing from the window is common
// (media still loading, filtered placeholders), a captured one missing from
// the store in the middle of a run is rarer, and a same-side swap is an edit.
const MATCH = 3;
const EDIT = -1;
const SKIP_STORED = -1;
const SKIP_CAPTURED = -2;
const NEVER = -1_000_000;

type Step =
  | { op: 'match'; c: number; s: number }
  | { op: 'edit'; c: number; s: number }
  | { op: 'new'; c: number }
  | { op: 'stored'; s: number };

/**
 * Where a captured window sits in the stored sequence: the best-scoring
 * contiguous stretch (Smith-Waterman), so a common "ok" can't match some
 * unrelated old "ok" on its own. Ties go to the newest stretch.
 */
export function localAlign(
  captured: string[],
  stored: string[],
  same = (c: number, s: number) => captured[c] === stored[s],
) {
  const n = captured.length;
  const m = stored.length;
  const width = m + 1;
  const score = new Int32Array((n + 1) * width);
  let best = 0;
  let bestAt = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const pair = same(i - 1, j - 1)
        ? MATCH
        : directionOf(captured[i - 1]!) === directionOf(stored[j - 1]!)
          ? EDIT
          : NEVER;
      const value = Math.max(
        0,
        score[(i - 1) * width + j - 1]! + pair,
        score[(i - 1) * width + j]! + SKIP_CAPTURED,
        score[i * width + j - 1]! + SKIP_STORED,
      );
      score[i * width + j] = value;
      if (value > 0 && value >= best) {
        best = value;
        bestAt = i * width + j;
      }
    }
  }
  if (best === 0) return null;

  const steps: Step[] = [];
  let i = Math.floor(bestAt / width);
  let j = bestAt % width;
  while (i > 0 && j > 0 && score[i * width + j]! > 0) {
    const here = score[i * width + j]!;
    const exact = same(i - 1, j - 1);
    const pair = exact ? MATCH : directionOf(captured[i - 1]!) === directionOf(stored[j - 1]!) ? EDIT : NEVER;
    if (here === score[(i - 1) * width + j - 1]! + pair) {
      steps.push({ op: exact ? 'match' : 'edit', c: i - 1, s: j - 1 });
      i--;
      j--;
    } else if (here === score[(i - 1) * width + j]! + SKIP_CAPTURED) {
      steps.push({ op: 'new', c: i - 1 });
      i--;
    } else {
      steps.push({ op: 'stored', s: j - 1 });
      j--;
    }
  }
  steps.reverse();
  // Trim edits and skips off the ends: a stretch starts and ends on exact matches.
  while (steps.length && steps[0]!.op !== 'match') steps.shift();
  while (steps.length && steps.at(-1)!.op !== 'match') steps.pop();
  return { steps, matches: steps.filter((s) => s.op === 'match').length };
}

function newId(anchor: string, signature: string, offset: number, timestamp: number): string {
  return 'c' + createHash('sha1').update(`${anchor}\0${signature}\0${offset}\0${timestamp}`).digest('hex').slice(0, 20);
}

/**
 * Times for a run of new messages strictly between `lo` and `hi`, as close to
 * what the page said (`desired`) as order allows. A message without a time
 * follows the one before it closely rather than being spread across the gap,
 * which would invent reply times; the newest ones get "now".
 */
function fitTimes(desired: (number | null)[], lo: number, hi: number, now: number): number[] {
  const count = desired.length;
  const times = [...desired];
  for (let k = 0; k < count;) {
    if (times[k] !== null) {
      k++;
      continue;
    }
    let end = k;
    while (end < count && times[end] === null) end++;
    const before = k > 0 ? times[k - 1]! : Number.isFinite(lo) ? lo : null;
    const after = end < count ? times[end]! : Number.isFinite(hi) ? hi : null;
    const run = end - k;
    for (let r = 0; r < run; r++) {
      times[k + r] =
        before !== null
          ? after === null
            ? Math.max(before + (r + 1) * STEP_MS, now - (run - 1 - r))
            : before + (r + 1) * STEP_MS
          : after !== null
            ? after - (run - r) * STEP_MS
            : now - (run - 1 - r);
    }
    k = end;
  }
  // Strictly increasing, inside (lo, hi) and not in the future. Squeezed when the neighbours are close.
  const top = Number.isFinite(lo) && lo >= now ? hi : Math.min(hi, now + STEP_MS);
  const step = Number.isFinite(top - lo) ? Math.min(STEP_MS, (top - lo) / (count + 1)) : STEP_MS;
  const out = times as number[];
  for (let k = 0; k < count; k++) out[k] = Math.max(out[k]!, (k > 0 ? out[k - 1]! : lo) + step);
  for (let k = count - 1; k >= 0; k--) out[k] = Math.min(out[k]!, (k < count - 1 ? out[k + 1]! : top) - step);
  return out.map(Math.round);
}

/**
 * Decide which captured messages are already stored and which are new, and
 * give every one an id and a timestamp that keeps the thread's order.
 *
 * - The window is placed by local alignment against everything stored: it
 *   needs a stretch of at least two exact matches (fewer only for tiny
 *   threads). A same-side message swapped inside that stretch is an edit.
 * - New messages get an id derived from the stored message before them and a
 *   time between their stored neighbours: the page's if it has one,
 *   otherwise interpolated, or "now" for the newest.
 * - A window that can't be placed is only taken when it's the newest part of
 *   the thread (or the thread has nothing stored); otherwise it's skipped
 *   rather than guessed at, since a misplaced window means duplicates.
 */
export function alignCapture(
  captured: CapturedMessage[],
  stored: StoredItem[],
  options: AlignOptions = {},
): AlignResult {
  const now = options.now ?? Date.now();
  if (captured.length === 0) return { messages: [] };
  if (captured.length * stored.length > MAX_CELLS) stored = stored.slice(-Math.floor(MAX_CELLS / captured.length));

  const signatures = captured.map((m) => signatureOf(m));
  const storedIds = new Set(stored.map((s) => s.nativeId));
  const alignment = localAlign(
    signatures,
    stored.map((s) => s.signature),
    // A page id, when there is one, is the only thing that matches.
    (c, s) => (captured[c]!.id ? captured[c]!.id === stored[s]!.nativeId : signatures[c] === stored[s]!.signature),
  );
  const anchored = alignment !== null && alignment.matches >= Math.min(MIN_ANCHOR, captured.length, stored.length);

  // The merged order: new messages before the stretch, the stretch, new messages after.
  let steps: Step[];
  if (anchored) {
    const first = alignment.steps[0] as { c: number; s: number };
    const last = alignment.steps.at(-1) as { c: number; s: number };
    steps = [
      ...captured.slice(0, first.c).map((_, c) => ({ op: 'new' as const, c })),
      ...alignment.steps,
      ...captured.slice(last.c + 1).map((_, k) => ({ op: 'new' as const, c: last.c + 1 + k })),
    ];
  } else {
    if (stored.length > 0 && options.atBottom === false) {
      return { skipped: 'This part of the conversation doesn’t line up with what’s stored yet' };
    }
    steps = captured.map((_, c) => ({ op: 'new' as const, c }));
  }

  // Stored neighbours of each new message, by stored index (-1 / stored.length beyond the ends).
  const prevStored: number[] = [];
  let lastS = anchored ? (alignment.steps[0] as { s: number }).s - 1 : options.atBottom ? stored.length - 1 : -1;
  for (const step of steps) {
    if (step.op === 'new') prevStored.push(lastS);
    else lastS = step.s;
  }
  // The newest stored message the window matched, for spotting times carried down from an old divider.
  const lastMatched = anchored ? (alignment.steps.at(-1) as { s: number }).s : -1;

  const result = new Map<number, AlignedMessage>();
  // Runs of consecutive new messages share their neighbours.
  const newSteps = steps.filter((s): s is { op: 'new'; c: number } => s.op === 'new');
  for (let k = 0; k < newSteps.length;) {
    const before = prevStored[k]!;
    let end = k;
    while (end < newSteps.length && prevStored[end] === before && newSteps[end]!.c === newSteps[k]!.c + (end - k))
      end++;
    const lo = before >= 0 ? stored[before]!.timestamp : -Infinity;
    const hi = before + 1 < stored.length ? stored[before + 1]!.timestamp : Infinity;
    const run = newSteps.slice(k, end);
    const desired = run.map(({ c }) => {
      const t = captured[c]!.timestamp;
      if (t === undefined) return null;
      // A live message below the last stored one still carries the old divider's time; it's new now.
      if (hi === Infinity && options.atBottom !== false && lastMatched >= 0 && t <= stored[lastMatched]!.timestamp) {
        return null;
      }
      return Math.min(t, now);
    });
    const times = fitTimes(desired, lo, hi, now);
    let anchor = before >= 0 ? stored[before]!.nativeId : 'start';
    run.forEach(({ c }, r) => {
      const id = captured[c]!.id ?? newId(anchor, signatures[c]!, r, times[r]!);
      result.set(c, {
        message: captured[c]!,
        nativeId: id,
        timestamp: times[r]!,
        isNew: !storedIds.has(id),
        edited: false,
      });
    });
    anchor = 'start';
    k = end;
  }
  for (const step of steps) {
    if (step.op !== 'match' && step.op !== 'edit') continue;
    const s = stored[step.s]!;
    const text = captured[step.c]!.text ?? '';
    const before = textOf(s.signature);
    result.set(step.c, {
      message: captured[step.c]!,
      nativeId: s.nativeId,
      timestamp: s.timestamp,
      isNew: false,
      edited: step.op === 'edit' && text !== '' && before !== '' && text !== before,
    });
  }
  return { messages: captured.map((_, c) => result.get(c)!) };
}
