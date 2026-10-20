import { describe, expect, it } from 'vitest';
import {
  findInstagramThreads,
  fixMetaEncoding,
  inferSelfFromThreads,
  parseInstagramThread,
} from '../src/importers/instagram';
import { igThread, mojibake } from './fixtures';

describe('fixMetaEncoding', () => {
  it('repairs UTF-8 that was written as Latin-1', () => {
    expect(fixMetaEncoding(mojibake('Olá ❤️ 😂'))).toBe('Olá ❤️ 😂');
  });
  it('leaves correct strings alone', () => {
    expect(fixMetaEncoding('plain')).toBe('plain');
    expect(fixMetaEncoding('already ❤️')).toBe('already ❤️');
    expect(fixMetaEncoding('café')).toBe('café'); // "é" alone isn't valid UTF-8 bytes
  });
});

describe('findInstagramThreads', () => {
  it('groups message files by thread, in file order', () => {
    const threads = findInstagramThreads([
      'your_instagram_activity/messages/inbox/alice_123/message_2.json',
      'your_instagram_activity/messages/inbox/alice_123/message_1.json',
      'your_instagram_activity/messages/inbox/alice_123/photos/1.jpg',
      'messages/message_requests/bob_456/message_1.json',
      'personal_information/personal_information.json',
    ]);
    expect([...threads.keys()]).toEqual([
      'your_instagram_activity/messages/inbox/alice_123',
      'messages/message_requests/bob_456',
    ]);
    expect(threads.get('your_instagram_activity/messages/inbox/alice_123')).toEqual([
      'your_instagram_activity/messages/inbox/alice_123/message_1.json',
      'your_instagram_activity/messages/inbox/alice_123/message_2.json',
    ]);
  });
});

describe('parseInstagramThread', () => {
  const base = { title: 'Alice', others: ['Alice'], self: 'Vince', path: 'inbox/alice_123' };
  const newer = igThread({
    ...base,
    messages: [
      {
        sender_name: 'Vince',
        timestamp_ms: 3000,
        content: 'https://instagram.com/p/xyz',
        share: { link: 'https://instagram.com/p/xyz' },
      },
      {
        sender_name: 'Alice',
        timestamp_ms: 2000,
        content: mojibake('haha 😂'),
        reactions: [{ reaction: mojibake('❤️'), actor: 'Vince' }],
      },
    ],
  });
  const older = igThread({
    ...base,
    messages: [
      { sender_name: 'Alice', timestamp_ms: 1500, content: 'Alice sent an attachment.' },
      {
        sender_name: 'Alice',
        timestamp_ms: 1000,
        photos: [{ uri: 'your_instagram_activity/messages/inbox/alice_123/photos/1.jpg' }],
      },
      { sender_name: 'Vince', timestamp_ms: 500, content: 'oops', is_unsent: true },
      { sender_name: 'Vince', timestamp_ms: 400, content: 'Liked a message' },
    ],
  });
  const chat = parseInstagramThread([newer, older], { selfName: 'Vince', threadDir: 'x/inbox/alice_123' });

  it('merges files and sorts oldest first', () => {
    expect(chat.messages.map((m) => m.timestamp)).toEqual([400, 500, 1000, 1500, 2000, 3000]);
    expect(chat.nativeId).toBe('inbox-alice-123');
    expect(chat.title).toBe('Alice');
  });

  it('maps content, reactions, shares, unsends and notices', () => {
    const [like, unsent, photo, placeholder, text, share] = chat.messages;
    expect(like!.kind).toBe('system');
    expect([unsent!.deleted, unsent!.text]).toEqual([true, null]);
    expect(photo!.attachments[0]).toMatchObject({
      type: 'image',
      archivePath: 'your_instagram_activity/messages/inbox/alice_123/photos/1.jpg',
    });
    expect([placeholder!.kind, placeholder!.text, placeholder!.attachments]).toEqual([
      'media',
      null,
      [{ type: 'other' }],
    ]);
    expect(text!.text).toBe('haha 😂');
    expect(text!.reactions).toEqual([{ emoji: '❤️', senderId: 'Vince', senderName: 'Vince' }]);
    expect(share!.fromSelf).toBe(true);
    expect(share!.text).toBeNull();
    expect(share!.attachments[0]).toMatchObject({ type: 'link', url: 'https://instagram.com/p/xyz' });
  });
});

describe('inferSelfFromThreads', () => {
  it('finds the one name present in every thread', () => {
    expect(
      inferSelfFromThreads([
        ['Alice', 'Vince'],
        ['Bob', 'Vince'],
        ['Carol', 'Dan', 'Vince'],
      ]),
    ).toBe('Vince');
  });
  it('gives up when it cannot tell', () => {
    expect(inferSelfFromThreads([['Alice', 'Vince']])).toBeNull();
    expect(
      inferSelfFromThreads([
        ['Alice', 'Vince'],
        ['Alice', 'Vince'],
      ]),
    ).toBeNull();
  });
});
