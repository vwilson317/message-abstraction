import type { Conversation, Message } from '../core/types';

/** A silence longer than this starts a new "session" of conversation. */
export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Gaps shorter than this aren't real replies: they come from sources whose
 * clocks are coarse (minute-precision exports, Instagram's occasional time
 * dividers), where messages are spaced a millisecond apart to keep order.
 */
const MIN_REPLY_MS = 1000;
/** Below this many real reply gaps, a median says more about noise than about a person. */
const MIN_REPLY_SAMPLES = 3;

export interface ParticipantStats {
  id: string;
  name: string;
  isSelf: boolean;
  messages: number;
  words: number;
  media: number;
  /** Sessions this person opened. */
  initiations: number;
  /** Median time this person took to answer someone else, within a session. */
  medianReplyMs: number | null;
}

export interface ConversationStats {
  totalMessages: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  activeDays: number;
  sessions: number;
  participants: ParticipantStats[];
  /** Messages per hour of day (0–23) and weekday (0 = Sunday), in server local time. */
  byHour: number[];
  byWeekday: number[];
  /** Messages per calendar month, oldest first, e.g. { month: '2024-03', count: 120 }. */
  byMonth: { month: string; count: number }[];
}

function median(values: number[]): number | null {
  if (values.length < MIN_REPLY_SAMPLES) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Cheap, deterministic signals about a conversation's rhythm: who talks more,
 * who reaches out first, how fast each side replies, and when. These are the
 * baseline an LLM layer can build on, and useful on their own.
 */
export function computeStats(conversation: Conversation, messages: Message[]): ConversationStats {
  const real = messages.filter((m) => m.kind !== 'system' && !m.deleted);
  const people = new Map<string, ParticipantStats & { replyTimes: number[] }>();
  const person = (m: Message) => {
    let p = people.get(m.senderId);
    if (!p) {
      const known = conversation.participants.find((x) => x.id === m.senderId);
      p = {
        id: m.senderId,
        name: known?.name ?? m.senderName,
        isSelf: m.fromSelf,
        messages: 0,
        words: 0,
        media: 0,
        initiations: 0,
        medianReplyMs: null,
        replyTimes: [],
      };
      people.set(m.senderId, p);
    }
    return p;
  };

  const byHour = Array<number>(24).fill(0);
  const byWeekday = Array<number>(7).fill(0);
  const months = new Map<string, number>();
  const days = new Set<string>();
  let sessions = 0;
  let previous: Message | undefined;

  for (const m of real) {
    const p = person(m);
    p.messages++;
    p.words += m.text ? m.text.split(/\s+/).filter(Boolean).length : 0;
    if (m.attachments.length) p.media++;

    const d = new Date(m.timestamp);
    byHour[d.getHours()]!++;
    byWeekday[d.getDay()]!++;
    const day = localDay(m.timestamp);
    days.add(day);
    months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) ?? 0) + 1);

    const gap = previous ? m.timestamp - previous.timestamp : Infinity;
    if (gap > SESSION_GAP_MS) {
      sessions++;
      p.initiations++;
    } else if (previous && previous.senderId !== m.senderId && gap > MIN_REPLY_MS) {
      p.replyTimes.push(gap);
    }
    previous = m;
  }

  return {
    totalMessages: real.length,
    firstMessageAt: real[0]?.timestamp ?? null,
    lastMessageAt: real.at(-1)?.timestamp ?? null,
    activeDays: days.size,
    sessions,
    participants: [...people.values()]
      .map(({ replyTimes, ...p }) => ({ ...p, medianReplyMs: median(replyTimes) }))
      .sort((a, b) => b.messages - a.messages),
    byHour,
    byWeekday,
    byMonth: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count })),
  };
}
