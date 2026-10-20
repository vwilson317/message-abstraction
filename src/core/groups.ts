/**
 * Conversation groups. You place a conversation in Close friends (the
 * default), Romantic interests or Ghosts. Two groups also follow from what
 * happens, so the tabs stay current on their own:
 *
 * - **Dates**: a romantic interest with a date you've scheduled, from now
 *   until 12 hours after it starts.
 * - **Ghosts**: a romantic interest where neither of you has written for 48
 *   hours. It leaves again as soon as someone writes.
 *
 * Shared by the server (metrics) and the web app (tabs), so both agree.
 */

export type GroupId = 'close' | 'romantic' | 'dates' | 'ghosts';

/** What's stored. Dates aren't stored as a group: a scheduled date puts a romantic interest there. */
export type AssignedGroup = 'close' | 'romantic' | 'ghosts';

export const GROUPS: { id: GroupId; label: string; short: string; description: string }[] = [
  { id: 'close', label: 'Close friends', short: 'Close', description: 'Everyone, unless you move them' },
  { id: 'romantic', label: 'Romantic interests', short: 'Romantic', description: 'No alerts or unread badges' },
  { id: 'dates', label: 'Dates', short: 'Dates', description: 'A date is scheduled' },
  { id: 'ghosts', label: 'Ghosts', short: 'Ghosts', description: 'Romantic interests silent for 48 hours' },
];

export const GHOST_AFTER_MS = 48 * 60 * 60 * 1000;
/** A date counts as "on" from when you schedule it until this long after it starts. */
export const DATE_GRACE_MS = 12 * 60 * 60 * 1000;

export interface GroupFields {
  group: AssignedGroup;
  /** When a date is (or was) scheduled, epoch ms. */
  dateAt: number | null;
  /** When the group or date was last set, epoch ms. */
  groupSetAt: number | null;
  lastMessageAt: number | null;
}

/** Alerts per group; Romantic interests (and Ghosts, which come from them) are muted by default. */
export type GroupAlerts = Record<GroupId, boolean>;
export const DEFAULT_GROUP_ALERTS: GroupAlerts = { close: true, romantic: false, dates: true, ghosts: false };

export function dateIsOn(c: Pick<GroupFields, 'dateAt'>, now: number): boolean {
  return c.dateAt !== null && now < c.dateAt + DATE_GRACE_MS;
}

/** The group a conversation shows in right now. */
export function effectiveGroup(c: GroupFields, now: number): GroupId {
  if (c.group === 'close') return 'close';
  if (dateIsOn(c, now)) return 'dates';
  // Marked as a ghost by hand: stays one until someone writes after that.
  if (c.group === 'ghosts' && !(c.lastMessageAt !== null && c.groupSetAt !== null && c.lastMessageAt > c.groupSetAt)) {
    return 'ghosts';
  }
  // A date that happened counts as contact too.
  const activity = Math.max(c.lastMessageAt ?? -Infinity, c.dateAt !== null && c.dateAt <= now ? c.dateAt : -Infinity);
  const since = Number.isFinite(activity) ? activity : c.groupSetAt;
  return since !== null && now - since >= GHOST_AFTER_MS ? 'ghosts' : 'romantic';
}

export type GroupChange = { group: 'close' | 'romantic' | 'ghosts' } | { group: 'dates'; dateAt: number };

/**
 * Apply a move from the long-press menu. Scheduling a date makes the
 * conversation a romantic interest; leaving romance clears any upcoming date
 * but keeps a past one, which the romantic metrics look back on.
 */
export function applyGroupChange(
  current: Pick<GroupFields, 'dateAt'>,
  change: GroupChange,
  now: number,
): Pick<GroupFields, 'group' | 'dateAt' | 'groupSetAt'> {
  const pastDate = current.dateAt !== null && !dateIsOn(current, now) ? current.dateAt : null;
  switch (change.group) {
    case 'dates':
      return { group: 'romantic', dateAt: change.dateAt, groupSetAt: now };
    case 'close':
      return { group: 'close', dateAt: null, groupSetAt: now };
    case 'romantic':
    case 'ghosts':
      return { group: change.group, dateAt: pastDate, groupSetAt: now };
  }
}
