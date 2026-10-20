import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { MessageInput } from '../src/core/connector';
import { applyGroupChange, DATE_GRACE_MS, effectiveGroup, GHOST_AFTER_MS, type GroupFields } from '../src/core/groups';
import type { Conversation, Message } from '../src/core/types';
import { computeGroupMetrics } from '../src/insights/groups';
import { createApp } from '../src/server/app';
import { Store } from '../src/store/db';
import { makeHub } from './helpers';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 20, 12, 0).getTime();

const fields = (over: Partial<GroupFields>): GroupFields => ({
  group: 'romantic',
  dateAt: null,
  groupSetAt: NOW - 10 * DAY,
  lastMessageAt: NOW - HOUR,
  ...over,
});

describe('effectiveGroup', () => {
  it('keeps close friends where they are, however quiet', () => {
    expect(effectiveGroup(fields({ group: 'close', lastMessageAt: NOW - 30 * DAY }), NOW)).toBe('close');
  });

  it('turns a romantic interest into a ghost after 48 silent hours, and back when someone writes', () => {
    expect(effectiveGroup(fields({ lastMessageAt: NOW - GHOST_AFTER_MS + 1 }), NOW)).toBe('romantic');
    expect(effectiveGroup(fields({ lastMessageAt: NOW - GHOST_AFTER_MS }), NOW)).toBe('ghosts');
    expect(effectiveGroup(fields({ lastMessageAt: NOW - 5 * DAY, groupSetAt: NOW - 6 * DAY }), NOW)).toBe('ghosts');
  });

  it('shows a romantic interest under Dates from scheduling until 12 hours after the date starts', () => {
    expect(effectiveGroup(fields({ dateAt: NOW + 2 * DAY, lastMessageAt: NOW - 5 * DAY }), NOW)).toBe('dates');
    expect(effectiveGroup(fields({ dateAt: NOW - DATE_GRACE_MS + 1 }), NOW)).toBe('dates');
    expect(effectiveGroup(fields({ dateAt: NOW - DATE_GRACE_MS - 1, lastMessageAt: NOW - 20 * HOUR }), NOW)).toBe(
      'romantic',
    );
  });

  it('counts the date itself as contact when deciding who has gone quiet', () => {
    // Last text 3 days ago, but the date was 30 hours ago: not a ghost yet.
    expect(effectiveGroup(fields({ dateAt: NOW - 30 * HOUR, lastMessageAt: NOW - 3 * DAY }), NOW)).toBe('romantic');
    expect(effectiveGroup(fields({ dateAt: NOW - 50 * HOUR, lastMessageAt: NOW - 3 * DAY }), NOW)).toBe('ghosts');
  });

  it('keeps a hand-marked ghost until someone writes after it was marked', () => {
    const marked = fields({ group: 'ghosts', groupSetAt: NOW - HOUR, lastMessageAt: NOW - 2 * HOUR });
    expect(effectiveGroup(marked, NOW)).toBe('ghosts');
    expect(effectiveGroup({ ...marked, lastMessageAt: NOW - 1000 }, NOW)).toBe('romantic');
  });
});

describe('applyGroupChange', () => {
  it('schedules a date as a romantic interest, and clears upcoming dates on the way out', () => {
    expect(applyGroupChange({ dateAt: null }, { group: 'dates', dateAt: NOW + DAY }, NOW)).toEqual({
      group: 'romantic',
      dateAt: NOW + DAY,
      groupSetAt: NOW,
    });
    expect(applyGroupChange({ dateAt: NOW + DAY }, { group: 'romantic' }, NOW).dateAt).toBeNull();
    expect(applyGroupChange({ dateAt: NOW - 3 * DAY }, { group: 'romantic' }, NOW).dateAt).toBe(NOW - 3 * DAY);
    expect(applyGroupChange({ dateAt: NOW - 3 * DAY }, { group: 'close' }, NOW).dateAt).toBeNull();
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────

let n = 0;
const m = (fromSelf: boolean, timestamp: number, text = 'hey', extra: Partial<Message> = {}): Message => ({
  id: `c:${++n}`,
  conversationId: 'c',
  nativeId: String(n),
  senderId: fromSelf ? 'me' : 'them',
  senderName: fromSelf ? 'You' : 'Sam',
  fromSelf,
  timestamp,
  kind: 'text',
  text,
  attachments: [],
  reactions: [],
  replyToNativeId: null,
  status: null,
  edited: false,
  deleted: false,
  ...extra,
});

const conversation = (over: Partial<Conversation>): Conversation => ({
  id: 'c',
  sourceId: 'whatsapp-mac',
  sourceKind: 'live',
  platform: 'whatsapp',
  nativeId: 'c',
  title: 'Sam',
  isGroup: false,
  participants: [],
  lastMessageAt: null,
  lastMessagePreview: null,
  unreadCount: 0,
  messageCount: 0,
  group: 'close',
  dateAt: null,
  groupSetAt: null,
  ...over,
});

describe('computeGroupMetrics', () => {
  it('close friends: last contact, usual rhythm, streaks and who reaches out', () => {
    // A chat every 2 days for 20 days, started by them each time, then 9 days of silence.
    const messages = Array.from({ length: 10 }, (_, i) => [
      m(false, NOW - (29 - 2 * i) * DAY),
      m(true, NOW - (29 - 2 * i) * DAY + 5 * 60_000),
    ]).flat();
    const metrics = computeGroupMetrics(conversation({ lastMessageAt: messages.at(-1)!.timestamp }), messages, NOW);
    expect(metrics).toMatchObject({
      group: 'close',
      usualGapMs: 2 * DAY,
      overdue: true,
      initiations: { you: 0, them: 10 },
      streakDays: { current: 0, longest: 1 },
    });
  });

  it('romantic interests: balance, replies, double texts, questions, momentum and the post-date text', () => {
    const t = NOW - 2 * DAY;
    const messages = [
      m(true, t, 'how was your day?'),
      m(false, t + 10 * 60_000, 'good! you?'),
      m(true, t + 12 * 60_000, 'great, long day though'),
      m(false, t + 40 * 60_000, 'want to get dinner saturday?'),
      m(true, t + 45 * 60_000, 'yes!'),
      m(false, t + 75 * 60_000, 'perfect'),
      m(true, t + 77 * 60_000, 'see you then'),
      m(true, t + 3 * HOUR, 'also, where?'), // a follow-up with no answer in between
    ];
    const date = t - 2 * DAY;
    const metrics = computeGroupMetrics(
      conversation({ group: 'romantic', dateAt: date, lastMessageAt: messages.at(-1)!.timestamp }),
      [m(false, date + 4 * HOUR, 'had fun tonight'), ...messages],
      NOW,
    );
    expect(metrics).toMatchObject({
      group: 'romantic',
      initiations: { you: 1, them: 1 },
      medianReplyMs: { you: 2 * 60_000, them: 28 * 60_000 },
      doubleTexts: { you: 1, them: 0 },
      questions: { you: 2, them: 2 },
      lastFrom: 'you',
      afterDate: { dateAt: date, firstFrom: 'them', firstAt: date + 4 * HOUR },
    });
  });

  it('dates: countdown inputs and lead-up since scheduling', () => {
    const scheduledAt = NOW - 2 * DAY;
    const messages = [m(true, scheduledAt - 5 * DAY), m(false, scheduledAt + HOUR), m(true, NOW - HOUR)];
    const metrics = computeGroupMetrics(
      conversation({ group: 'romantic', dateAt: NOW + DAY, groupSetAt: scheduledAt, lastMessageAt: NOW - HOUR }),
      messages,
      NOW,
    );
    expect(metrics).toMatchObject({
      group: 'dates',
      dateAt: NOW + DAY,
      sinceScheduled: { messages: 2 },
      leadUp: { recentPerDay: 2 / 3, beforePerDay: 1 / 14 },
      lastFrom: 'you',
    });
  });

  it('ghosts: how long, who is waiting, unanswered messages and how it ended', () => {
    const t = NOW - 5 * DAY;
    const messages = [
      m(false, t - DAY, 'hi'),
      m(true, t - DAY + 60_000, 'hey'),
      m(false, t - DAY + 2 * 60_000, 'how are you'),
      m(true, t - DAY + 3 * 60_000, 'good'),
      m(false, t - DAY + 7 * 60_000, 'nice'),
      m(true, t, 'drinks this week?'),
      m(true, t + HOUR, 'no worries if not'),
    ];
    const metrics = computeGroupMetrics(conversation({ group: 'romantic', lastMessageAt: t + HOUR }), messages, NOW);
    expect(metrics).toMatchObject({
      group: 'ghosts',
      silentSinceAt: t + HOUR,
      lastFrom: 'you',
      unanswered: 2,
      usualReplyMs: 150_000, // they used to answer in 1 and 4 minutes
      firstAt: t - DAY,
      total: 7,
    });
    expect((metrics as { lastExchange: unknown[] }).lastExchange).toHaveLength(3);
  });
});

// ── Storage and API ─────────────────────────────────────────────────────────

describe('groups in the store and API', () => {
  it('adds the group columns to a database created by an earlier version', () => {
    const { dir } = makeHub();
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      platform TEXT NOT NULL, native_id TEXT NOT NULL, title TEXT NOT NULL, is_group INTEGER NOT NULL DEFAULT 0,
      participants TEXT NOT NULL DEFAULT '[]', last_message_at INTEGER, last_message_preview TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO conversations (id, source_id, source_kind, platform, native_id, title) VALUES ('a', 's', 'live', 'whatsapp', 'a', 'A');`);
    old.close();
    const store = new Store(path);
    expect(store.getConversation('a')).toMatchObject({ group: 'close', dateAt: null, groupSetAt: null });
    store.close();
  });

  it('moves conversations, schedules dates and stores alert settings over the API', async () => {
    const { hub, events } = makeHub();
    const msg: MessageInput = {
      conversationNativeId: 'sam',
      nativeId: 'm1',
      senderId: 'sam',
      senderName: 'Sam',
      fromSelf: false,
      timestamp: Date.now(),
      kind: 'text',
      text: 'hi',
    };
    hub.upsertMessages('whatsapp-mac', 'live', [msg], { countUnread: false });
    const app = createApp(hub, { allowedHosts: ['localhost'], extensionIds: [], maxUploadBytes: 1024 });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(`http://localhost:4310${path}`, {
        method,
        headers: { host: 'localhost:4310', 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    const id = encodeURIComponent('whatsapp-mac:sam');

    expect(hub.requireConversation('whatsapp-mac:sam').group).toBe('close');
    const dateAt = Date.now() + 2 * DAY;
    const res = await call('PATCH', `/api/conversations/${id}`, { group: 'dates', dateAt });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ group: 'romantic', dateAt });
    expect(events.at(-1)).toMatchObject({ type: 'conversation.upserted', conversation: { dateAt } });

    expect(
      (await call('PATCH', `/api/conversations/${id}`, { group: 'dates', dateAt: Date.now() - 3 * DAY })).status,
    ).toBe(400);
    expect((await call('PATCH', `/api/conversations/${id}`, { group: 'besties' })).status).toBe(400);

    const insights = (await (await call('GET', `/api/conversations/${id}/insights`)).json()) as {
      groupMetrics: { group: string };
    };
    expect(insights.groupMetrics.group).toBe('dates');

    expect(await (await call('GET', '/api/settings')).json()).toEqual({
      groupAlerts: { close: true, romantic: false, dates: true, ghosts: false },
    });
    const updated = await call('PATCH', '/api/settings', { groupAlerts: { romantic: true } });
    expect(((await updated.json()) as { groupAlerts: { romantic: boolean } }).groupAlerts.romantic).toBe(true);
    expect((await call('PATCH', '/api/settings', { groupAlerts: { everyone: true } })).status).toBe(400);
  });
});
