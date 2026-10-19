import { describe, expect, it } from 'vitest';
import type { Connector, ConnectorContext, MessageInput } from '../src/core/connector';
import { makeHub } from './helpers';

const msg = (overrides: Partial<MessageInput> = {}): MessageInput => ({
  conversationNativeId: 'alice',
  nativeId: 'm1',
  senderId: 'alice',
  senderName: 'Alice',
  fromSelf: false,
  timestamp: 1_000,
  kind: 'text',
  text: 'hi',
  ...overrides,
});

class FakeConnector implements Connector {
  readonly id = 'fake';
  readonly platform = 'whatsapp' as const;
  readonly label = 'Fake';
  readonly capabilities = { send: true, liveUpdates: true };
  ctx?: ConnectorContext;
  sent: string[] = [];
  async hasSession() {
    return false;
  }
  async start(ctx: ConnectorContext) {
    this.ctx = ctx;
    ctx.setStatus({ state: 'connected', detail: 'ok' });
  }
  async stop() {}
  async logout() {}
  async sendText(conversationNativeId: string, text: string): Promise<MessageInput> {
    this.sent.push(text);
    return msg({
      conversationNativeId,
      nativeId: `out-${this.sent.length}`,
      text,
      fromSelf: true,
      senderId: 'me',
      senderName: 'You',
      timestamp: 5_000,
      status: 'sent',
    });
  }
}

describe('Hub', () => {
  it('namespaces ids and keeps conversation summaries up to date', () => {
    const { hub } = makeHub();
    hub.upsertConversation('wa', 'live', { platform: 'whatsapp', nativeId: 'alice', title: 'Alice' });
    hub.upsertMessages('wa', 'live', [msg(), msg({ nativeId: 'm2', timestamp: 2_000, text: 'there' })], {
      countUnread: true,
    });
    const c = hub.requireConversation('wa:alice');
    expect(c).toMatchObject({ messageCount: 2, unreadCount: 2, lastMessageAt: 2_000, lastMessagePreview: 'there' });
    expect(hub.store.getMessage('wa:alice:m2')?.text).toBe('there');
  });

  it('does not count backfill, own messages or duplicates as unread', () => {
    const { hub } = makeHub();
    hub.upsertMessages('wa', 'live', [msg()], { countUnread: false });
    hub.upsertMessages('wa', 'live', [msg({ nativeId: 'm2', fromSelf: true })], { countUnread: true });
    hub.upsertMessages('wa', 'live', [msg()], { countUnread: true });
    expect(hub.requireConversation('wa:alice')).toMatchObject({ unreadCount: 0, messageCount: 2 });
    expect(hub.markRead('wa:alice').unreadCount).toBe(0);
  });

  it('never lets a re-delivered message undo an edit, delete or read receipt', () => {
    const { hub } = makeHub();
    hub.upsertMessages('wa', 'live', [msg({ fromSelf: true, status: 'sent' })], { countUnread: false });
    hub.patchMessage('wa', {
      conversationNativeId: 'alice',
      nativeId: 'm1',
      text: 'hi (edited)',
      edited: true,
      status: 'read',
    });
    hub.upsertMessages('wa', 'live', [msg({ fromSelf: true, status: 'delivered' })], { countUnread: false });
    expect(hub.store.getMessage('wa:alice:m1')).toMatchObject({ text: 'hi (edited)', edited: true, status: 'read' });

    hub.patchMessage('wa', { conversationNativeId: 'alice', nativeId: 'm1', deleted: true });
    hub.upsertMessages('wa', 'live', [msg({ fromSelf: true })], { countUnread: false });
    expect(hub.store.getMessage('wa:alice:m1')).toMatchObject({ deleted: true, text: null });
    expect(hub.requireConversation('wa:alice').lastMessagePreview).toBe('You: Message deleted');
  });

  it('adds, replaces and removes reactions per sender', () => {
    const { hub } = makeHub();
    hub.upsertMessages('wa', 'live', [msg()], { countUnread: false });
    const react = (emoji: string, senderId = 'me') =>
      hub.patchMessage('wa', {
        conversationNativeId: 'alice',
        nativeId: 'm1',
        reaction: { emoji, senderId, senderName: senderId },
      });
    react('👍');
    react('❤️');
    react('😂', 'bob');
    expect(hub.store.getMessage('wa:alice:m1')!.reactions.map((r) => r.emoji)).toEqual(['❤️', '😂']);
    react('');
    expect(hub.store.getMessage('wa:alice:m1')!.reactions.map((r) => r.emoji)).toEqual(['😂']);
  });

  it('emits one bulk event for large batches instead of one per message', () => {
    const { hub, events } = makeHub();
    const many = Array.from({ length: 40 }, (_, i) => msg({ nativeId: `m${i}`, timestamp: i }));
    hub.upsertMessages('wa', 'live', many, { countUnread: false });
    expect(events.filter((e) => e.type === 'message.upserted')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'messages.bulk')).toEqual([
      { type: 'messages.bulk', conversationId: 'wa:alice' },
    ]);
  });

  it('paginates newest-first with a stable cursor across equal timestamps', () => {
    const { hub } = makeHub();
    const inputs = Array.from({ length: 7 }, (_, i) =>
      msg({ nativeId: `m${i}`, timestamp: i < 4 ? 100 : 200 + i, text: `#${i}` }),
    );
    hub.upsertMessages('wa', 'live', inputs, { countUnread: false });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = hub.store.listMessages('wa:alice', { limit: 3, ...(cursor && { before: cursor }) });
      seen.unshift(...page.messages.map((m) => m.text!));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['#0', '#1', '#2', '#3', '#4', '#5', '#6']);
  });

  it('re-derives which messages are yours when you pick yourself', () => {
    const { hub } = makeHub();
    hub.upsertConversation('import:whatsapp', 'import', {
      platform: 'whatsapp',
      nativeId: 'chat',
      participants: [
        { id: 'Alice', name: 'Alice', isSelf: false },
        { id: 'Vince', name: 'Vince', isSelf: false },
      ],
    });
    hub.upsertMessages(
      'import:whatsapp',
      'import',
      [
        msg({ conversationNativeId: 'chat', senderId: 'Alice', senderName: 'Alice' }),
        msg({ conversationNativeId: 'chat', nativeId: 'm2', senderId: 'Vince', senderName: 'Vince' }),
      ],
      { countUnread: false },
    );
    hub.setSelf('import:whatsapp:chat', 'Vince');
    expect(hub.store.allMessages('import:whatsapp:chat').map((m) => m.fromSelf)).toEqual([false, true]);
    expect(() => hub.setSelf('import:whatsapp:chat', 'Nobody')).toThrow(/not a participant/);
  });

  it('routes sends through the owning connector and refuses read-only imports', async () => {
    const { hub } = makeHub();
    const fake = new FakeConnector();
    hub.register(fake);
    await hub.startConnector('fake');
    fake.ctx!.upsertConversation({ platform: 'whatsapp', nativeId: 'alice', title: 'Alice' });

    const sent = await hub.sendText('fake:alice', '  hello  ');
    expect(fake.sent).toEqual(['hello']);
    expect(sent).toMatchObject({ id: 'fake:alice:out-1', fromSelf: true, status: 'sent' });
    expect(hub.requireConversation('fake:alice').lastMessagePreview).toBe('You: hello');

    hub.upsertConversation('import:whatsapp', 'import', { platform: 'whatsapp', nativeId: 'old' });
    await expect(hub.sendText('import:whatsapp:old', 'hi')).rejects.toThrow(/read-only/);
    await hub.stopConnector('fake');
    await expect(hub.sendText('fake:alice', 'hi')).rejects.toThrow(/not connected/);
  });

  it('deletes a conversation and its messages', () => {
    const { hub } = makeHub();
    hub.upsertMessages('wa', 'live', [msg()], { countUnread: false });
    hub.deleteConversation('wa:alice');
    expect(hub.store.getConversation('wa:alice')).toBeUndefined();
    expect(hub.store.getMessage('wa:alice:m1')).toBeUndefined();
  });
});
