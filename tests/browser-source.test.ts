import { describe, expect, it } from 'vitest';
import {
  alignCapture,
  localAlign,
  signatureOf,
  type AlignedMessage,
  type StoredItem,
} from '../src/connectors/browser/align';
import { BrowserSource, parseCapture, type CapturedMessage } from '../src/connectors/browser/source';
import { createApp } from '../src/server/app';
import { makeHub } from './helpers';

const msg = (senderName: string, text: string, extra: Partial<CapturedMessage> = {}): CapturedMessage => ({
  senderName: senderName === 'me' ? '' : senderName,
  fromSelf: senderName === 'me',
  text,
  ...extra,
});

function messagesOf(result: ReturnType<typeof alignCapture>): AlignedMessage[] {
  if (!('messages' in result)) throw new Error(`skipped: ${result.skipped}`);
  return result.messages;
}

function storedFrom(...results: ReturnType<typeof alignCapture>[]): StoredItem[] {
  const byId = new Map<string, StoredItem>();
  for (const result of results) {
    for (const a of messagesOf(result)) {
      byId.set(a.nativeId, { nativeId: a.nativeId, signature: signatureOf(a.message), timestamp: a.timestamp });
    }
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

const DAY = 24 * 60 * 60 * 1000;

describe('localAlign', () => {
  it('finds where a slice sits even with repeated short messages', () => {
    const found = localAlign(['ok', 'b', 'ok'], ['a', 'ok', 'b', 'ok', 'c']);
    expect(found?.matches).toBe(3);
    expect(found?.steps).toEqual([
      { op: 'match', c: 0, s: 1 },
      { op: 'match', c: 1, s: 2 },
      { op: 'match', c: 2, s: 3 },
    ]);
  });
});

describe('alignCapture', () => {
  const NOW = 1_700_000_000_000;

  it('treats a first capture as new and keeps its order, using page times when present', () => {
    const aligned = messagesOf(
      alignCapture([msg('Maya', 'hey', { timestamp: NOW - 60_000 }), msg('me', 'hi!'), msg('Maya', 'ok')], [], {
        now: NOW,
      }),
    );
    expect(aligned.map((a) => a.isNew)).toEqual([true, true, true]);
    const times = aligned.map((a) => a.timestamp);
    expect(times[0]).toBe(NOW - 60_000);
    expect(times[1]! > times[0]! && times[2]! > times[1]!).toBe(true);
    expect(new Set(aligned.map((a) => a.nativeId)).size).toBe(3);
  });

  it('recognises already-stored messages and only adds what is new', () => {
    const first = alignCapture([msg('Maya', 'hey'), msg('me', 'ok'), msg('Maya', 'ok')], [], { now: NOW });
    const second = messagesOf(
      alignCapture([msg('me', 'ok'), msg('Maya', 'ok'), msg('me', 'ok'), msg('Maya', 'see you')], storedFrom(first), {
        now: NOW + 5000,
      }),
    );
    expect(second.map((a) => a.isNew)).toEqual([false, false, true, true]);
    expect(second[0]!.nativeId).toBe(messagesOf(first)[1]!.nativeId);
    expect(second[2]!.timestamp > messagesOf(first)[2]!.timestamp).toBe(true);
  });

  it('places older history before what is stored, without duplicating', () => {
    const recent = alignCapture([msg('Maya', 'latest')], [], { now: NOW });
    const older = messagesOf(
      alignCapture([msg('Maya', 'earlier'), msg('me', 'reply'), msg('Maya', 'latest')], storedFrom(recent), {
        now: NOW,
      }),
    );
    expect(older.map((a) => a.isNew)).toEqual([true, true, false]);
    expect(older[0]!.timestamp < older[1]!.timestamp && older[1]!.timestamp < older[2]!.timestamp).toBe(true);
  });

  it('uses ids from the page when it has them', () => {
    const stored: StoredItem[] = [{ nativeId: 'm1', signature: 'x', timestamp: NOW - 10 }];
    const aligned = messagesOf(
      alignCapture([msg('Maya', 'edited text', { id: 'm1' }), msg('Maya', 'new', { id: 'm2' })], stored, {
        now: NOW,
      }),
    );
    expect(aligned.map((a) => [a.nativeId, a.isNew])).toEqual([
      ['m1', false],
      ['m2', true],
    ]);
  });

  it('won’t pin a window on one common message matching some old one', () => {
    const old = alignCapture([msg('Maya', 'ok'), msg('me', 'see you tomorrow'), msg('Maya', 'bye')], [], {
      now: NOW - DAY,
    });
    const fresh = messagesOf(
      alignCapture([msg('Maya', 'are you there?'), msg('Maya', 'ok'), msg('Maya', 'call me')], storedFrom(old), {
        now: NOW,
        atBottom: true,
      }),
    );
    expect(fresh.map((a) => a.isNew)).toEqual([true, true, true]);
    // After everything stored, not before it.
    expect(fresh[0]!.timestamp > Math.max(...storedFrom(old).map((s) => s.timestamp))).toBe(true);
  });

  it('skips a window it can’t place unless it’s the newest part of the thread', () => {
    const stored = storedFrom(alignCapture([msg('Maya', 'a'), msg('me', 'b')], [], { now: NOW }));
    const window = [msg('Maya', 'x'), msg('me', 'y')];
    expect(alignCapture(window, stored, { now: NOW, atBottom: false })).toEqual({
      skipped: expect.stringContaining('line up'),
    });
    expect(messagesOf(alignCapture(window, stored, { now: NOW, atBottom: true })).every((a) => a.isNew)).toBe(true);
  });

  it('matches undated messages at the top of a window to old stored ones instead of duplicating them', () => {
    const oct15 = Date.UTC(2026, 9, 15, 18, 0);
    const first = alignCapture(
      [msg('Maya', 'dinner?'), msg('me', 'sure'), msg('Maya', 'see you at 8')].map((m) => ({
        ...m,
        timestamp: oct15,
      })),
      [],
      { now: oct15 + 60_000 },
    );
    const oct20 = Date.UTC(2026, 9, 20, 10, 42);
    // Five days later the old divider has scrolled out of view.
    const second = messagesOf(
      alignCapture(
        [msg('me', 'sure'), msg('Maya', 'see you at 8'), msg('Maya', 'morning!', { timestamp: oct20 })],
        storedFrom(first),
        { now: oct20 + 60_000, atBottom: true },
      ),
    );
    expect(second.map((a) => a.isNew)).toEqual([false, false, true]);
    expect(second[2]!.timestamp).toBe(oct20);
  });

  it('lines up history windows with no time dividers anywhere in a long thread', () => {
    const thread = Array.from({ length: 600 }, (_, i) => msg(i % 2 ? 'me' : 'Maya', `message ${i}`));
    const stored = storedFrom(alignCapture(thread, [], { now: NOW }));
    const window = messagesOf(alignCapture(thread.slice(50, 70), stored, { now: NOW + DAY, atBottom: false }));
    expect(window.every((a) => !a.isNew)).toBe(true);
    expect(window.map((a) => a.nativeId)).toEqual(stored.slice(50, 70).map((s) => s.nativeId));
  });

  it('slots a message that appears late (a photo that finished loading) between its neighbours', () => {
    const d = Date.UTC(2026, 9, 20, 10, 42);
    const first = alignCapture(
      [msg('Maya', 'A'), msg('Maya', 'B'), msg('me', 'C')].map((m) => ({ ...m, timestamp: d })),
      [],
      { now: d + 60_000 },
    );
    const stored = storedFrom(first);
    const photo = msg('Maya', '', { text: null, attachments: [{ type: 'image' }], timestamp: d });
    const second = messagesOf(
      alignCapture([msg('Maya', 'A', { timestamp: d }), photo, msg('Maya', 'B', { timestamp: d })], stored, {
        now: d + 120_000,
      }),
    );
    expect(second.map((a) => a.isNew)).toEqual([false, true, false]);
    expect(second[1]!.timestamp > stored[0]!.timestamp && second[1]!.timestamp < stored[1]!.timestamp).toBe(true);
  });

  it('treats a changed bubble between matches as an edit of the stored message', () => {
    const first = alignCapture([msg('Maya', 'A'), msg('Maya', 'see you at 7'), msg('me', 'C')], [], { now: NOW });
    const second = messagesOf(
      alignCapture([msg('Maya', 'A'), msg('Maya', 'see you at 8'), msg('me', 'C')], storedFrom(first), {
        now: NOW + 1000,
      }),
    );
    expect(second.map((a) => [a.isNew, a.edited])).toEqual([
      [false, false],
      [false, true],
      [false, false],
    ]);
    expect(second[1]!.nativeId).toBe(messagesOf(first)[1]!.nativeId);
  });

  it('dates a live message "now", not by the divider it sits under', () => {
    const divider = Date.UTC(2026, 9, 20, 10, 42);
    const first = alignCapture(
      [msg('Maya', 'A'), msg('me', 'B')].map((m) => ({ ...m, timestamp: divider })),
      [],
      {
        now: divider + 60_000,
      },
    );
    const later = divider + 4 * 60 * 60 * 1000;
    const second = messagesOf(
      alignCapture(
        [msg('Maya', 'A'), msg('me', 'B'), msg('Maya', 'still there?')].map((m) => ({ ...m, timestamp: divider })),
        storedFrom(first),
        { now: later, atBottom: true },
      ),
    );
    expect(second[2]).toMatchObject({ isNew: true, timestamp: later });
  });

  it('never dates anything in the future, and never invents reply gaps for untimed messages', () => {
    const aligned = messagesOf(
      alignCapture([msg('Maya', 'a'), msg('me', 'b'), msg('Maya', 'c', { timestamp: NOW + DAY }), msg('me', 'd')], [], {
        now: NOW,
      }),
    );
    const times = aligned.map((a) => a.timestamp);
    expect(Math.max(...times)).toBeLessThanOrEqual(NOW);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThan(0);
    expect(times[1]! - times[0]!).toBeLessThan(1000);
  });
});

describe('parseCapture', () => {
  it('rejects malformed captures and strips unsafe values', () => {
    expect(() => parseCapture({})).toThrow(/missing thread/);
    expect(() => parseCapture({ thread: { id: '../x', title: 'x' }, messages: [] })).toThrow(/unexpected characters/);
    const capture = parseCapture({
      thread: { id: '1234', title: 'Maya', participants: ['Maya', 42] },
      messages: [
        {
          senderName: 'Maya',
          text: 'look',
          attachments: [
            { type: 'image', url: 'javascript:alert(1)' },
            { type: 'image', url: 'https://cdn.example/x.jpg' },
            { type: 'bogus' },
          ],
        },
      ],
    });
    expect(capture.thread.participants).toEqual(['Maya']);
    expect(capture.messages[0]!.attachments).toEqual([
      { type: 'image' },
      { type: 'image', url: 'https://cdn.example/x.jpg' },
    ]);
  });
});

function setup() {
  const ctx = makeHub();
  const source = new BrowserSource('instagram-web', 'instagram', 'Instagram (Chrome)', 'Open Instagram', (id) =>
    ctx.store
      .messagesBetween(id, 0, Number.MAX_SAFE_INTEGER, 50_000)
      .map((m) => ({ nativeId: m.nativeId, signature: signatureOf(m), timestamp: m.timestamp })),
  );
  ctx.hub.register(source);
  return { ...ctx, source };
}

describe('BrowserSource', () => {
  const capture = (messages: object[]) => ({ thread: { id: '340282366841710301244276', title: 'Maya' }, messages });

  it('stores captures, ignores repeats and appends new messages', async () => {
    const { hub, events } = setup();
    await hub.startConnector('instagram-web');
    expect(hub.connectorStatuses()[0]!.state).toBe('needs_setup');

    const first = hub.receive('instagram-web', capture([msg('Maya', 'hey'), msg('me', 'hi')]));
    expect(first).toEqual({ conversationId: 'instagram-web:340282366841710301244276', added: 2 });
    expect(hub.connectorStatuses()[0]!.state).toBe('connected');

    const before = events.length;
    expect(hub.receive('instagram-web', capture([msg('Maya', 'hey'), msg('me', 'hi')])).added).toBe(0);
    expect(events.slice(before).filter((e) => e.type === 'message.upserted')).toEqual([]);

    expect(
      hub.receive('instagram-web', capture([msg('Maya', 'hey'), msg('me', 'hi'), msg('Maya', 'what’s up?')])).added,
    ).toBe(1);
    expect(hub.store.allMessages(first.conversationId).map((m) => [m.senderName, m.text])).toEqual([
      ['Maya', 'hey'],
      ['You', 'hi'],
      ['Maya', 'what’s up?'],
    ]);
    expect(hub.requireConversation(first.conversationId)).toMatchObject({ platform: 'instagram', sourceKind: 'live' });
  });

  it('keeps a group a group when one window shows a single speaker, and doesn’t name senders after it', async () => {
    const { hub } = setup();
    await hub.startConnector('instagram-web');
    const thread = { id: 'g1', title: 'Weekend plans' };
    const { conversationId } = hub.receive('instagram-web', {
      thread: { ...thread, isGroup: true, participants: ['sam_r', 'jo.k'] },
      messages: [msg('sam_r', 'who’s in?'), msg('jo.k', 'me')],
    });
    // A later window where only one person is visible, so the page can't tell it's a group.
    hub.receive('instagram-web', {
      thread: { ...thread, isGroup: false },
      messages: [msg('sam_r', 'who’s in?'), msg('Weekend plans', 'me'), msg('Weekend plans', 'saturday?')],
    });
    const conversation = hub.requireConversation(conversationId);
    expect(conversation.isGroup).toBe(true);
    expect(conversation.participants.map((p) => p.id)).not.toContain('Weekend plans');
    expect(hub.store.allMessages(conversationId).map((m) => [m.senderName, m.text])).toEqual([
      ['sam_r', 'who’s in?'],
      ['jo.k', 'me'],
      ['Unknown', 'saturday?'],
    ]);
  });

  it('refuses captures once stopped, and starting twice doesn’t stack timers', async () => {
    const { hub } = setup();
    await hub.startConnector('instagram-web');
    await hub.startConnector('instagram-web');
    await hub.stopConnector('instagram-web');
    expect(() => hub.receive('instagram-web', capture([msg('Maya', 'hey')]))).toThrow(/stopped/);
    expect(() => hub.heartbeat('instagram-web')).toThrow(/stopped/);
    expect(hub.connectorStatuses()[0]!.state).toBe('stopped');
  });
});

describe('capture API', () => {
  function app() {
    const ctx = setup();
    void ctx.hub.startConnector('instagram-web');
    const server = createApp(ctx.hub, {
      allowedHosts: ['localhost'],
      extensionIds: ['abcdefghijklmnop'],
      maxUploadBytes: 1024,
    });
    const post = (path: string, origin: string, body?: unknown) =>
      server.request(`http://localhost:4310${path}`, {
        method: 'POST',
        headers: { host: 'localhost:4310', origin, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    return { ...ctx, post };
  }
  const body = { thread: { id: '42', title: 'Maya' }, messages: [msg('Maya', 'hey')] };

  it('accepts captures from the pinned extension only', async () => {
    const { post } = app();
    expect(
      (await post('/api/connectors/instagram-web/captures', 'chrome-extension://abcdefghijklmnop', body)).status,
    ).toBe(200);
    expect(
      (await post('/api/connectors/instagram-web/captures', 'chrome-extension://someotherextension', body)).status,
    ).toBe(403);
    expect((await post('/api/connectors/instagram-web/captures', 'https://evil.example', body)).status).toBe(403);
  });

  it('keeps every other write same-origin, even for the extension', async () => {
    const { post } = app();
    expect((await post('/api/connectors/instagram-web/disconnect', 'chrome-extension://abcdefghijklmnop')).status).toBe(
      403,
    );
    expect((await post('/api/connectors/instagram-web/heartbeat', 'chrome-extension://abcdefghijklmnop')).status).toBe(
      200,
    );
  });
});
