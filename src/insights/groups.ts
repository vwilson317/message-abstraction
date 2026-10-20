import { effectiveGroup, type GroupId } from '../core/groups';
import type { Conversation, Message } from '../core/types';
import { SESSION_GAP_MS } from './stats';

/**
 * The signals that matter differ by group: with close friends it's keeping
 * in touch, with a romantic interest it's balance and momentum, before a
 * date it's the lead-up, and with a ghost it's the silence itself.
 */

const DAY = 24 * 60 * 60 * 1000;
const MIN_REPLY_MS = 1000;
/** A follow-up you send after this long with no answer in between counts as a double text. */
const DOUBLE_TEXT_AFTER_MS = 60 * 60 * 1000;
/** Treat a date as over this long after it starts, for "after the date" signals. */
const DATE_LENGTH_MS = 3 * 60 * 60 * 1000;

/** You and them, side by side. "Them" is everyone else in the chat. */
export interface Pair {
  you: number;
  them: number;
}

export interface CloseMetrics {
  group: 'close';
  lastAt: number | null;
  /** Typical time between conversations (median gap between conversation starts). */
  usualGapMs: number | null;
  /** Silence has run well past the usual gap. */
  overdue: boolean;
  /** Who started conversations in the last 90 days. */
  initiations: Pair;
  /** Messages per week: the last 4 weeks and the 4 before. */
  perWeek: { recent: number; previous: number };
  streakDays: { current: number; longest: number };
}

export interface RomanticMetrics {
  group: 'romantic';
  /** All figures cover the last 30 days. */
  initiations: Pair;
  medianReplyMs: { you: number | null; them: number | null };
  /** Their median reply time this week vs the three weeks before. */
  theirReplyTrend: { recent: number | null; previous: number | null };
  wordsPerMessage: Pair;
  doubleTexts: Pair;
  questions: Pair;
  /** Messages in the last 7 days vs the 7 before. */
  momentum: { recent: number; previous: number };
  lastFrom: 'you' | 'them' | null;
  lastAt: number | null;
  /** After a date you had: who wrote first, and when. */
  afterDate: { dateAt: number; firstFrom: 'you' | 'them' | null; firstAt: number | null } | null;
}

export interface DateMetrics {
  group: 'dates';
  dateAt: number;
  scheduledAt: number | null;
  /** Since you scheduled it. */
  sinceScheduled: { messages: number; initiations: Pair };
  /** Messages per day over the last 3 days, and over the 14 days before you scheduled. */
  leadUp: { recentPerDay: number; beforePerDay: number };
  lastFrom: 'you' | 'them' | null;
  lastAt: number | null;
}

export interface GhostMetrics {
  group: 'ghosts';
  silentSinceAt: number | null;
  /** Who sent the last message, i.e. who's waiting for an answer. */
  lastFrom: 'you' | 'them' | null;
  /** Messages in a row at the end from whoever wrote last. */
  unanswered: number;
  /** How fast the side that owes a reply usually answers. */
  usualReplyMs: number | null;
  lastExchange: { fromSelf: boolean; text: string; timestamp: number }[];
  firstAt: number | null;
  total: number;
}

export type GroupMetrics = CloseMetrics | RomanticMetrics | DateMetrics | GhostMetrics;

function real(messages: Message[]): Message[] {
  return messages.filter((m) => m.kind !== 'system' && !m.deleted);
}

function side(m: Message): 'you' | 'them' {
  return m.fromSelf ? 'you' : 'them';
}

function pair(): Pair {
  return { you: 0, them: 0 };
}

function median(values: number[], min = 3): number | null {
  if (values.length < min) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function between(messages: Message[], from: number, to = Infinity): Message[] {
  return messages.filter((m) => m.timestamp >= from && m.timestamp < to);
}

/** Messages that open a conversation: the first ever, or one after 6+ hours of silence. */
function conversationStarts(all: Message[]): Set<Message> {
  return new Set(all.filter((m, i) => i === 0 || m.timestamp - all[i - 1]!.timestamp > SESSION_GAP_MS));
}

/** Who started the conversations among these messages. */
function initiations(messages: Message[], starts: Set<Message>): Pair {
  const counts = pair();
  for (const m of messages) if (starts.has(m)) counts[side(m)]++;
  return counts;
}

/** Reply gaps by whoever replied, within conversations, ignoring sub-second clock artefacts. */
function replyGaps(messages: Message[]): { you: number[]; them: number[] } {
  const gaps = { you: [] as number[], them: [] as number[] };
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!;
    const m = messages[i]!;
    const gap = m.timestamp - prev.timestamp;
    if (prev.fromSelf !== m.fromSelf && gap > MIN_REPLY_MS && gap <= SESSION_GAP_MS) gaps[side(m)].push(gap);
  }
  return gaps;
}

function localDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function streaks(messages: Message[], now: number): { current: number; longest: number } {
  const days = [...new Set(messages.map((m) => localDay(m.timestamp)))].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    // Calendar days differ by 23-25 hours across DST changes.
    run = i > 0 && Math.round((days[i]! - days[i - 1]!) / DAY) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  // A streak is still alive if you talked today or yesterday.
  const today = localDay(now);
  const last = days.at(-1);
  const current = last !== undefined && Math.round((today - last) / DAY) <= 1 ? run : 0;
  return { current, longest };
}

function close(c: Conversation, all: Message[], starts: Set<Message>, now: number): CloseMetrics {
  const startList = [...starts];
  const gaps = startList.slice(1).map((m, i) => m.timestamp - startList[i]!.timestamp);
  const usualGapMs = median(gaps);
  const lastAt = all.at(-1)?.timestamp ?? c.lastMessageAt;
  const silence = lastAt === null ? 0 : now - lastAt;
  return {
    group: 'close',
    lastAt,
    usualGapMs,
    overdue: usualGapMs !== null && silence > Math.max(2 * usualGapMs, 3 * DAY),
    initiations: initiations(between(all, now - 90 * DAY), starts),
    perWeek: {
      recent: between(all, now - 28 * DAY).length / 4,
      previous: between(all, now - 56 * DAY, now - 28 * DAY).length / 4,
    },
    streakDays: streaks(all, now),
  };
}

function romantic(c: Conversation, all: Message[], starts: Set<Message>, now: number): RomanticMetrics {
  const month = between(all, now - 30 * DAY);
  const gaps = replyGaps(month);
  const theirRecent = replyGaps(between(all, now - 7 * DAY)).them;
  const theirPrevious = replyGaps(between(all, now - 30 * DAY, now - 7 * DAY)).them;

  const words = pair();
  const counts = pair();
  const questions = pair();
  const doubles = pair();
  month.forEach((m, i) => {
    const s = side(m);
    counts[s]++;
    words[s] += m.text ? m.text.split(/\s+/).filter(Boolean).length : 0;
    if (m.text?.includes('?')) questions[s]++;
    const prev = month[i - 1];
    if (prev && prev.fromSelf === m.fromSelf && m.timestamp - prev.timestamp >= DOUBLE_TEXT_AFTER_MS) doubles[s]++;
  });

  let afterDate: RomanticMetrics['afterDate'] = null;
  if (c.dateAt !== null && c.dateAt <= now) {
    const first = all.find((m) => m.timestamp >= c.dateAt! + DATE_LENGTH_MS);
    afterDate = { dateAt: c.dateAt, firstFrom: first ? side(first) : null, firstAt: first?.timestamp ?? null };
  }

  const last = all.at(-1);
  return {
    group: 'romantic',
    initiations: initiations(month, starts),
    medianReplyMs: { you: median(gaps.you), them: median(gaps.them) },
    theirReplyTrend: { recent: median(theirRecent, 2), previous: median(theirPrevious, 2) },
    wordsPerMessage: {
      you: counts.you ? words.you / counts.you : 0,
      them: counts.them ? words.them / counts.them : 0,
    },
    doubleTexts: doubles,
    questions,
    momentum: {
      recent: between(all, now - 7 * DAY).length,
      previous: between(all, now - 14 * DAY, now - 7 * DAY).length,
    },
    lastFrom: last ? side(last) : null,
    lastAt: last?.timestamp ?? null,
    afterDate,
  };
}

function dates(c: Conversation, all: Message[], starts: Set<Message>, now: number): DateMetrics {
  const scheduledAt = c.groupSetAt;
  const since = scheduledAt === null ? [] : between(all, scheduledAt);
  const recent = between(all, now - 3 * DAY);
  const before = scheduledAt === null ? [] : between(all, scheduledAt - 14 * DAY, scheduledAt);
  const last = all.at(-1);
  return {
    group: 'dates',
    dateAt: c.dateAt!,
    scheduledAt,
    sinceScheduled: { messages: since.length, initiations: initiations(since, starts) },
    leadUp: { recentPerDay: recent.length / 3, beforePerDay: before.length / 14 },
    lastFrom: last ? side(last) : null,
    lastAt: last?.timestamp ?? null,
  };
}

function ghosts(c: Conversation, all: Message[]): GhostMetrics {
  const last = all.at(-1);
  let unanswered = 0;
  for (let i = all.length - 1; i >= 0 && all[i]!.fromSelf === last?.fromSelf; i--) unanswered++;
  // The side that owes a reply is the one that didn't write last.
  const gaps = replyGaps(all);
  const owes = last ? (last.fromSelf ? 'them' : 'you') : null;
  return {
    group: 'ghosts',
    silentSinceAt: last?.timestamp ?? c.lastMessageAt,
    lastFrom: last ? side(last) : null,
    unanswered,
    usualReplyMs: owes ? median(gaps[owes], 2) : null,
    lastExchange: all.slice(-3).map((m) => ({
      fromSelf: m.fromSelf,
      text: m.text ?? (m.attachments[0] ? `[${m.attachments[0].type}]` : ''),
      timestamp: m.timestamp,
    })),
    firstAt: all[0]?.timestamp ?? null,
    total: all.length,
  };
}

/** Metrics for the group the conversation is in right now. */
export function computeGroupMetrics(c: Conversation, messages: Message[], now = Date.now()): GroupMetrics {
  const all = real(messages);
  const starts = conversationStarts(all);
  const group: GroupId = effectiveGroup(c, now);
  switch (group) {
    case 'close':
      return close(c, all, starts, now);
    case 'romantic':
      return romantic(c, all, starts, now);
    case 'dates':
      return dates(c, all, starts, now);
    case 'ghosts':
      return ghosts(c, all);
  }
}
