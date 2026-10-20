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
const MIN = 60_000;
const messages = [
  m('Alice', start, 'morning, how are you'),
  m('Vince', start + 10 * MIN, 'good!'),
  m('Alice', start + 12 * MIN, 'great'),
  m('Vince', start + 13 * MIN, 'system noise', { kind: 'system' }),
  m('Vince', start + 14 * MIN, 'you?'),
  m('Alice', start + 20 * MIN, 'all good'),
  m('Vince', start + 24 * HOUR, 'new day'),
  m('Alice', start + 24 * HOUR + 30 * MIN, 'hey', {
    reactions: [{ emoji: '❤️', senderId: 'Vince', senderName: 'Vince' }],
  }),
];

describe('computeStats', () => {
  const stats = computeStats(conversation, messages);

  it('counts sessions, initiations and reply times, skipping system messages', () => {
    expect(stats.totalMessages).toBe(7);
    expect(stats.sessions).toBe(2);
    expect(stats.activeDays).toBe(2);
    const alice = stats.participants.find((p) => p.id === 'Alice')!;
    const vince = stats.participants.find((p) => p.id === 'Vince')!;
    // Alice replied after 2m, 6m and 30m; Vince after 10m and 2m (too few for a median).
    expect([alice.messages, alice.words, alice.initiations, alice.medianReplyMs]).toEqual([4, 8, 1, 6 * MIN]);
    expect([vince.messages, vince.initiations, vince.medianReplyMs, vince.isSelf]).toEqual([3, 1, null, true]);
    expect(stats.byHour[9]).toBe(7);
    expect(stats.byMonth).toEqual([{ month: '2024-03', count: 7 }]);
  });

  it('ignores sub-second gaps, which come from coarse clocks rather than real replies', () => {
    const coarse = [0, 1, 2, 3, 4, 5].map((i) => m(i % 2 ? 'Vince' : 'Alice', start + i, `#${i}`));
    expect(computeStats(conversation, coarse).participants.every((p) => p.medianReplyMs === null)).toBe(true);
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
