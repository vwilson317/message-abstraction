import { closeSync, ftruncateSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Connector } from '../src/core/connector';
import { createApp, parseRange, type AppOptions } from '../src/server/app';
import { Store } from '../src/store/db';
import { ANDROID_CHAT } from './fixtures';
import { makeHub } from './helpers';

function setup(options: Partial<AppOptions> = {}) {
  const ctx = makeHub();
  const app = createApp(ctx.hub, {
    allowedHosts: ['localhost', '127.0.0.1'],
    extensionIds: [],
    maxUploadBytes: 1024 * 1024,
    ...options,
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`http://localhost:4310${path}`, { ...init, headers: { host: 'localhost:4310', ...init.headers } });
  return { ...ctx, app, request };
}

async function importAndroid(request: ReturnType<typeof setup>['request']) {
  const form = new FormData();
  form.set('file', new File([ANDROID_CHAT], 'WhatsApp Chat with Alice.txt', { type: 'text/plain' }));
  return request('/api/import', { method: 'POST', body: form });
}

describe('API', () => {
  it('imports an upload and serves conversations, messages, insights and transcripts', async () => {
    const { request } = setup();
    const imported = await importAndroid(request);
    expect(imported.status).toBe(200);
    const summary = (await imported.json()) as { conversations: { id: string }[] };
    const id = encodeURIComponent(summary.conversations[0]!.id);

    const list = (await (await request('/api/conversations')).json()) as { title: string }[];
    expect(list.map((c) => c.title)).toEqual(['Alice']);

    const page = (await (await request(`/api/conversations/${id}/messages?limit=3`)).json()) as {
      messages: unknown[];
      nextCursor: string;
    };
    expect(page.messages).toHaveLength(3);
    expect(page.nextCursor).toMatch(/^\d+_\d+$/);

    const stats = (await (await request(`/api/conversations/${id}/insights`)).json()) as { totalMessages: number };
    expect(stats.totalMessages).toBe(7); // 9 minus the encryption notice and the deleted message

    const transcript = await request(`/api/conversations/${id}/transcript?download`);
    expect(transcript.headers.get('content-disposition')).toBe('attachment; filename="Alice.txt"');
    expect(await transcript.text()).toContain('Vince: Yes! Send me the link');
  });

  it('lets you say which participant you are', async () => {
    const { request, hub } = setup();
    await importAndroid(request);
    const res = await request(`/api/conversations/${encodeURIComponent('import:whatsapp:alice')}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selfParticipantId: 'Alice' }),
    });
    expect(res.status).toBe(200);
    expect(
      hub.store
        .allMessages('import:whatsapp:alice')
        .filter((m) => m.fromSelf)
        .every((m) => m.senderName === 'Alice'),
    ).toBe(true);
  });

  it('rejects unknown Host headers (DNS rebinding)', async () => {
    const { app } = setup();
    const res = await app.request('http://evil.example/api/conversations', { headers: { host: 'evil.example' } });
    expect(res.status).toBe(403);
  });

  it('rejects cross-site writes (CSRF), including text/plain bodies', async () => {
    const { request } = setup();
    const crossSite = await request('/api/connectors/whatsapp/connect', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    const plain = await request(`/api/conversations/x`, {
      method: 'PATCH',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(plain.status).toBe(400);
  });

  it('serves only content-addressed media files, sandboxed', async () => {
    const { request, media } = setup();
    const url = media.save(new Uint8Array([1, 2, 3]), { fileName: 'a.jpg' });
    const ok = await request(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(ok.headers.get('content-security-policy')).toBe('sandbox');
    expect((await request('/api/media/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
  });

  it('streams media with byte ranges, and only to this app', async () => {
    const { request, media } = setup();
    const url = media.save(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), { fileName: 'clip.mp4' });
    const full = await request(url);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-length')).toBe('10');
    expect(full.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect([...new Uint8Array(await full.arrayBuffer())]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const part = await request(url, { headers: { range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(part.headers.get('content-length')).toBe('3');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2, 3, 4]);

    const tail = await request(url, { headers: { range: 'bytes=-3' } });
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([7, 8, 9]);
    const open = await request(url, { headers: { range: 'bytes=8-' } });
    expect(open.headers.get('content-range')).toBe('bytes 8-9/10');

    const beyond = await request(url, { headers: { range: 'bytes=20-' } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */10');
    // Several ranges, or a backwards one, get the whole file.
    expect((await request(url, { headers: { range: 'bytes=0-1,4-5' } })).status).toBe(200);
    expect((await request(url, { headers: { range: 'bytes=5-2' } })).status).toBe(200);

    const head = await request(url, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('10');
    expect((await request(url, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await request(url, { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });

  it('serves connector media over 2 GiB without reading it into memory', async () => {
    const { request, hub, dir } = setup();
    const path = join(dir, 'huge.mp4');
    const size = 2.5 * 1024 ** 3;
    const fd = openSync(path, 'w');
    ftruncateSync(fd, size); // sparse: takes no disk space
    writeSync(fd, Uint8Array.from([7, 8, 9]), 0, 3, size - 3);
    closeSync(fd);
    const connector: Connector = {
      id: 'files',
      platform: 'whatsapp',
      label: 'Files',
      shouldAutoStart: async () => false,
      start: async () => {},
      stop: async () => {},
      mediaFile: (ref) => (ref === '1' ? path : null),
    };
    hub.register(connector);

    const end = await request('/api/connectors/files/media/1', { headers: { range: 'bytes=-3' } });
    expect(end.status).toBe(206);
    expect(end.headers.get('content-range')).toBe(`bytes ${size - 3}-${size - 1}/${size}`);
    expect([...new Uint8Array(await end.arrayBuffer())]).toEqual([7, 8, 9]);
    const whole = await request('/api/connectors/files/media/1');
    expect(whole.headers.get('content-length')).toBe(String(size));
    await whole.body?.cancel();
    expect((await request('/api/connectors/files/media/2')).status).toBe(404);
  });

  it('parses single byte ranges', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-0', 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-20', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('items=0-1', 10)).toBeNull();
  });

  it('lets only the configured extension frame the app', async () => {
    const pinned = setup({ extensionIds: ['abcdefghijklmnopabcdefghijklmnop'] });
    const web = join(pinned.dir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Inbox</title>');
    const app = createApp(pinned.hub, {
      allowedHosts: ['localhost'],
      extensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
      maxUploadBytes: 1024,
      staticDir: web,
    });
    const page = await app.request('http://localhost:4310/', { headers: { host: 'localhost:4310' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    );

    const open = createApp(pinned.hub, {
      allowedHosts: ['localhost'],
      extensionIds: [],
      maxUploadBytes: 1024,
      staticDir: web,
    });
    const any = await open.request('http://localhost:4310/', { headers: { host: 'localhost:4310' } });
    expect(any.headers.get('content-security-policy')).toBe("frame-ancestors 'self' chrome-extension:");
  });

  it('turns conversations left by the old WhatsApp web connector into deletable ones', async () => {
    const { store, dir } = setup();
    store.saveConversation({
      id: 'whatsapp:15551230000@s.whatsapp.net',
      sourceId: 'whatsapp',
      sourceKind: 'live',
      platform: 'whatsapp',
      nativeId: '15551230000@s.whatsapp.net',
      title: 'Alice',
      isGroup: false,
      participants: [],
      lastMessageAt: null,
      lastMessagePreview: null,
      unreadCount: 0,
      messageCount: 0,
      group: 'close',
      dateAt: null,
      groupSetAt: null,
    });
    const reopened = new Store(join(dir, 'test.db'));
    try {
      expect(reopened.getConversation('whatsapp:15551230000@s.whatsapp.net')?.sourceKind).toBe('import');
    } finally {
      reopened.close();
    }
  });

  it('returns 404 for unknown conversations and connectors', async () => {
    const { request } = setup();
    expect((await request('/api/conversations/nope')).status).toBe(404);
    expect((await request('/api/connectors/nope/connect', { method: 'POST' })).status).toBe(404);
  });
});
