const DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Conversation list: time today, weekday this week, date otherwise. */
export function listTime(ts: number | null): string {
  if (ts === null) return '';
  const today = startOfDay(Date.now());
  if (ts >= today) return timeOfDay(ts);
  if (ts >= today - 6 * DAY) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  const sameYear = new Date(ts).getFullYear() === new Date().getFullYear();
  return new Date(ts).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(!sameYear && { year: '2-digit' }),
  });
}

/** Thread day separators. */
export function dayLabel(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return 'Today';
  if (day === today - DAY) return 'Yesterday';
  if (day > today - 7 * DAY) return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function fullDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s+]/gu, '')
    .trim()
    .split(/\s+/);
  if (parts[0]?.startsWith('+')) return '#';
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
}

/** A stable hue per name, for avatars and sender labels. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

/** "Sat, Oct 24 · 8:00 PM" */
export function dateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${timeOfDay(ts)}`;
}

/** How long since `ts`, in words: "3 days", "5 hours", "a few minutes". */
export function sinceLabel(ts: number | null, now: number): string {
  if (ts === null) return 'a long time';
  const ms = Math.max(0, now - ts);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 5) return 'a few minutes';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.round(hours / 24), 'day');
}

/** "in 3 days", "in 5 hours", "now" for a time ahead. */
export function untilLabel(ts: number, now: number): string {
  const ms = ts - now;
  if (ms <= 0) return 'now';
  const hours = ms / 3_600_000;
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 36) return `in ${plural(Math.round(hours), 'hour')}`;
  return `in ${plural(Math.round(hours / 24), 'day')}`;
}
