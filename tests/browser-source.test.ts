import { describe, expect, it } from 'vitest';
import { alignCapture, lcsPairs, signatureOf, type StoredItem } from '../src/connectors/browser/align';
import { BrowserSource, parseCapture, type CapturedMessage } from '../src/connectors/browser/source';
import { createApp } from '../src/server/app';
import { makeHub } from './helpers';

const msg = (senderName: string, text: string, extra: Partial<CapturedMessage> = {}): CapturedMessage => ({
  senderName: senderName === 'me' ? '' : senderName,
  fromSelf: senderName === 'me',
  text,
  ...extra,
});

function storedFrom(aligned: ReturnType<typeof alignCapture>): StoredItem[] {
  return aligned.map((a) => ({ nativeId: a.nativeId, signature: signatureOf(a.message), timestamp: a.timestamp }));
}

describe('lcsPairs', () => {
  it('finds where a slice sits even with repeated short messages', () => {
    expect(lcsPairs(['ok', 'b', 'ok'], ['a', 'ok', 'b', 'ok', 'c'])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });
});

describe('alignCapture', () => {
  const NOW = 1_700_000_000_000;

  it('treats a first capture as new and keeps its order, using page times when present', () => {
    const aligned = alignCapture(
      [msg('Maya', 'hey', { timestamp: NOW - 60_000 }), msg('me', 'hi!'), msg('Maya', 'ok')],
      [],
      NOW,
    );
    expect(aligned.map((a) => a.isNew)).toEqual([true, true, true]);
    const times = aligned.map((a) => a.timestamp);
    expect(times[0]).toBe(NOW - 60_000);
    expect(times[1]! > times[0]! && times[2]! > times[1]!).toBe(true);
    expect(new Set(aligned.map((a) => a.nativeId)).size).toBe(3);
  });

  it('recognises already-stored messages and only adds what is new', () => {
    const first = alignCapture([msg('Maya', 'hey'), msg('me', 'ok'), msg('Maya', 'ok')], [], NOW);
    const second = alignCapture(
      [msg('me', 'ok'), msg('Maya', 'ok'), msg('me', 'ok'), msg('Maya', 'see you')],
      storedFrom(first),
      NOW + 5000,
    );
    expect(second.map((a) => a.isNew)).toEqual([false, false, true, true]);
    expect(second[0]!.nativeId).toBe(first[1]!.nativeId);
    expect(second[2]!.timestamp > first[2]!.timestamp).toBe(true);
  });

  it('places older history before what is stored, without duplicating', () => {
    const recent = alignCapture([msg('Maya', 'latest')], [], NOW);
    const older = alignCapture(
      [msg('Maya', 'earlier'), msg('me', 'reply'), msg('Maya', 'latest')],
      storedFrom(recent),
      NOW,
    );
    expect(older.map((a) => a.isNew)).toEqual([true, true, false]);
    expect(older[0]!.timestamp < older[1]!.timestamp && older[1]!.timestamp < older[2]!.timestamp).toBe(true);
  });

  it('uses ids from the page when it has them', () => {
    const stored: StoredItem[] = [{ nativeId: 'm1', signature: 'x', timestamp: NOW - 10 }];
    const aligned = alignCapture(
      [msg('Maya', 'edited text', { id: 'm1' }), msg('Maya', 'new', { id: 'm2' })],
      stored,
      NOW,
    );
    expect(aligned.map((a) => [a.nativeId, a.isNew])).toEqual([
      ['m1', false],
      ['m2', true],
    ]);
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
  const source = new BrowserSource('instagram-web', 'instagram', 'Instagram (Chrome)', 'Open Instagram', (id, range) =>
    (range
      ? ctx.store.messagesBetween(id, range.from, range.to, 5000)
      : ctx.store.listMessages(id, { limit: 500 }).messages
    ).map((m) => ({ nativeId: m.nativeId, signature: signatureOf(m), timestamp: m.timestamp })),
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

    expect(hub.receive('instagram-web', capture([msg('me', 'hi'), msg('Maya', 'what’s up?')])).added).toBe(1);
    expect(hub.store.allMessages(first.conversationId).map((m) => [m.senderName, m.text])).toEqual([
      ['Maya', 'hey'],
      ['You', 'hi'],
      ['Maya', 'what’s up?'],
    ]);
    expect(hub.requireConversation(first.conversationId)).toMatchObject({ platform: 'instagram', sourceKind: 'live' });
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
