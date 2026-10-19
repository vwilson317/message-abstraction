import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '../src/core/types';
import { computeStats } from '../src/insights/stats';
import { formatTranscript } from '../src/insights/transcript';

const HOUR = 3_600_000;
const conversation: Conversation = {
  id: 'c',
  sourceId: 'import:whatsapp',
  sourceKind: 'import',
  platform: 'whatsapp',
  nativeId: 'c',
  title: 'Alice',
  isGroup: false,
  participants: [
    { id: 'Alice', name: 'Alice', isSelf: false },
    { id: 'Vince', name: 'Vince', isSelf: true },
  ],
  lastMessageAt: null,
  lastMessagePreview: null,
  unreadCount: 0,
  messageCount: 0,
};

let n = 0;
const m = (sender: 'Alice' | 'Vince', timestamp: number, text: string, extra: Partial<Message> = {}): Message => ({
  id: `c:${++n}`,
  conversationId: 'c',
  nativeId: String(n),
  senderId: sender,
  senderName: sender,
  fromSelf: sender === 'Vince',
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

const start = new Date(2024, 2, 12, 9, 0).getTime();
const messages = [
  m('Alice', start, 'morning, how are you'),
  m('Vince', start + 10 * 60_000, 'good!'),
  m('Alice', start + 12 * 60_000, 'great'),
  m('Vince', start + 13 * 60_000, 'system noise', { kind: 'system' }),
  m('Vince', start + 24 * HOUR, 'new day'),
  m('Alice', start + 24 * HOUR + 30 * 60_000, 'hey', {
    reactions: [{ emoji: '❤️', senderId: 'Vince', senderName: 'Vince' }],
  }),
];

describe('computeStats', () => {
  const stats = computeStats(conversation, messages);

  it('counts sessions, initiations and reply times, skipping system messages', () => {
    expect(stats.totalMessages).toBe(5);
    expect(stats.sessions).toBe(2);
    expect(stats.activeDays).toBe(2);
    const alice = stats.participants.find((p) => p.id === 'Alice')!;
    const vince = stats.participants.find((p) => p.id === 'Vince')!;
    expect([alice.messages, alice.words, alice.initiations, alice.medianReplyMs]).toEqual([
      3,
      6,
      1,
      ((2 + 30) / 2) * 60_000,
    ]);
    expect([vince.messages, vince.initiations, vince.medianReplyMs, vince.isSelf]).toEqual([2, 1, 10 * 60_000, true]);
    expect(stats.byHour[9]).toBe(5);
    expect(stats.byMonth).toEqual([{ month: '2024-03', count: 5 }]);
  });
});

describe('formatTranscript', () => {
  it('produces a readable, LLM-ready transcript', () => {
    const text = formatTranscript(conversation, messages, { last: 2 });
    expect(text).toBe(
      [
        '# Alice',
        '# WhatsApp direct conversation',
        '# Participants: Alice, Vince (me)',
        '# 2 messages, 2024-03-13 09:00 to 2024-03-13 09:30',
        '',
        '[2024-03-13 09:00] Vince: new day',
        '[2024-03-13 09:30] Alice: hey {❤️ Vince}',
        '',
      ].join('\n'),
    );
  });
});
