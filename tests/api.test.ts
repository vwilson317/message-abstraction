import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { ANDROID_CHAT } from './fixtures';
import { makeHub } from './helpers';

function setup() {
  const ctx = makeHub();
  const app = createApp(ctx.hub, {
    allowedHosts: ['localhost', '127.0.0.1'],
    extensionIds: [],
    maxUploadBytes: 1024 * 1024,
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

  it('returns 404 for unknown conversations and connectors', async () => {
    const { request } = setup();
    expect((await request('/api/conversations/nope')).status).toBe(404);
    expect((await request('/api/connectors/nope/connect', { method: 'POST' })).status).toBe(404);
  });
});
