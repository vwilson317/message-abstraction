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
  ctx?: ConnectorContext;
  stopped = false;
  async shouldAutoStart() {
    return true;
  }
  async start(ctx: ConnectorContext) {
    this.ctx = ctx;
    ctx.setStatus({ state: 'connected', detail: 'watching' });
  }
  async stop() {
    this.stopped = true;
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

  it('lets an authoritative mirror replace text, marking the change as an edit', () => {
    const { hub } = makeHub();
    const live = { countUnread: false, authoritative: true };
    hub.upsertMessages('wa', 'live', [msg()], live);
    hub.upsertMessages('wa', 'live', [msg({ text: 'edit one', edited: true })], live);
    // Edited again while nothing was watching: a re-read just has the new text.
    hub.upsertMessages('wa', 'live', [msg({ text: 'edit two' })], live);
    expect(hub.store.getMessage('wa:alice:m1')).toMatchObject({ text: 'edit two', edited: true });
    // A caption arriving where there was no text isn't an edit.
    hub.upsertMessages('wa', 'live', [msg({ nativeId: 'm2', text: null, kind: 'media' })], live);
    hub.upsertMessages('wa', 'live', [msg({ nativeId: 'm2', text: 'caption', kind: 'media' })], live);
    expect(hub.store.getMessage('wa:alice:m2')).toMatchObject({ text: 'caption', edited: false });
  });

  it('clears text and attachments when a delete arrives as an upsert', () => {
    const { hub } = makeHub();
    hub.upsertMessages('wa', 'live', [msg({ kind: 'media', attachments: [{ type: 'image', url: '/x' }] })], {
      countUnread: false,
    });
    hub.upsertMessages('wa', 'live', [msg({ text: null, attachments: [], deleted: true })], { countUnread: false });
    expect(hub.store.getMessage('wa:alice:m1')).toMatchObject({ deleted: true, text: null, attachments: [] });
  });

  it('replaces reactions with what the source reports, and keeps them when it reports none', () => {
    const { hub } = makeHub();
    const heart = { emoji: '❤️', senderId: 'bob', senderName: 'Bob' };
    hub.upsertMessages('wa', 'live', [msg({ reactions: [heart] })], { countUnread: false });
    hub.upsertMessages('wa', 'live', [msg()], { countUnread: false });
    expect(hub.store.getMessage('wa:alice:m1')!.reactions).toEqual([heart]);
    hub.upsertMessages('wa', 'live', [msg({ reactions: [] })], { countUnread: false });
    expect(hub.store.getMessage('wa:alice:m1')!.reactions).toEqual([]);
  });

  it('folds one conversation into another, keeping the more recent group and missing messages', () => {
    const { hub, events } = makeHub();
    hub.upsertMessages('wa', 'live', [msg({ conversationNativeId: 'lid', nativeId: 'a', timestamp: 5_000 })], {
      countUnread: false,
    });
    hub.upsertMessages('wa', 'live', [msg({ conversationNativeId: 'phone', nativeId: 'b', timestamp: 1_000 })], {
      countUnread: false,
    });
    hub.setGroup('wa:lid', { group: 'romantic' }, 10_000);
    hub.retireConversation('wa', 'lid', 'phone');
    expect(hub.store.getConversation('wa:lid')).toBeUndefined();
    expect(hub.requireConversation('wa:phone')).toMatchObject({
      group: 'romantic',
      groupSetAt: 10_000,
      messageCount: 2,
      lastMessageAt: 5_000,
    });
    expect(events).toContainEqual({ type: 'conversation.deleted', conversationId: 'wa:lid' });
    hub.retireConversation('wa', 'lid', 'phone'); // already gone: nothing happens
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

  it('starts connectors at boot, namespaces what they report, and stops them', async () => {
    const { hub, events } = makeHub();
    const fake = new FakeConnector();
    hub.register(fake);
    await hub.autoStart();
    expect(hub.connectorStatuses()).toEqual([
      { id: 'fake', platform: 'whatsapp', label: 'Fake', state: 'connected', detail: 'watching' },
    ]);
    fake.ctx!.upsertConversation({ platform: 'whatsapp', nativeId: 'alice', title: 'Alice' });
    fake.ctx!.upsertMessages([msg()], { countUnread: true });
    expect(hub.requireConversation('fake:alice')).toMatchObject({ sourceKind: 'live', unreadCount: 1 });

    await hub.startConnector('fake'); // already running: no second start
    await hub.stopConnector('fake');
    expect(fake.stopped).toBe(true);
    expect(events.filter((e) => e.type === 'connector.status').at(-1)).toMatchObject({ status: { state: 'stopped' } });
  });

  it('deletes a conversation and its messages', () => {
    const { hub } = makeHub();
    hub.upsertMessages('wa', 'live', [msg()], { countUnread: false });
    hub.deleteConversation('wa:alice');
    expect(hub.store.getConversation('wa:alice')).toBeUndefined();
    expect(hub.store.getMessage('wa:alice:m1')).toBeUndefined();
  });
});
