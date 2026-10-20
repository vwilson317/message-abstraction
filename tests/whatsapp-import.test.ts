import { describe, expect, it } from 'vitest';
import { looksLikeWhatsAppChat, parseWhatsAppChat, titleFromFileName } from '../src/importers/whatsapp';
import { ANDROID_CHAT, IOS_CHAT } from './fixtures';

const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

describe('titleFromFileName', () => {
  it.each([
    ['WhatsApp Chat with Alice.txt', 'Alice'],
    ['WhatsApp Chat with Alice (1).txt', 'Alice'],
    ['WhatsApp Chat - Trip Crew.zip', 'Trip Crew'],
    ['_chat.txt', null],
  ])('%s → %s', (name, expected) => expect(titleFromFileName(name)).toBe(expected));
});

describe('Android export', () => {
  const chat = parseWhatsAppChat(ANDROID_CHAT, { fileName: 'WhatsApp Chat with Alice.txt' });

  it('detects the format', () => expect(looksLikeWhatsAppChat(ANDROID_CHAT)).toBe(true));

  it('infers who you are from the file name in a 1:1 chat', () => {
    expect(chat.title).toBe('Alice');
    expect(chat.selfName).toBe('Vince');
    expect(chat.isGroup).toBe(false);
    expect(chat.participants.map((p) => [p.name, p.isSelf])).toEqual([
      ['Alice', false],
      ['Vince', true],
    ]);
  });

  it('reads day-first dates and keeps same-minute messages in order', () => {
    const [notice, first, second] = chat.messages;
    expect(notice!.kind).toBe('system');
    expect(notice!.senderId).toBe('system');
    expect(first!.timestamp).toBe(local(2024, 3, 12, 9, 15) + 1);
    expect(second!.timestamp).toBe(local(2024, 3, 12, 9, 15) + 2);
    expect(second!.text).toBe('Also, I found the place\nit has a terrace\nand a view');
  });

  it('recognises media, deletions, edits, attachments and locations', () => {
    const byText = (fn: (m: (typeof chat.messages)[number]) => boolean) => chat.messages.find(fn)!;
    expect(byText((m) => m.kind === 'media' && m.attachments[0]?.type === 'other').text).toBeNull();
    const deleted = byText((m) => !!m.deleted);
    expect([deleted.senderName, deleted.fromSelf, deleted.text]).toEqual(['Vince', true, null]);
    const edited = byText((m) => !!m.edited);
    expect(edited.text).toBe('See you then 😊');
    const photo = byText((m) => m.attachments[0]?.archivePath !== undefined);
    expect(photo.attachments[0]).toMatchObject({ type: 'image', archivePath: 'IMG-20240314-WA0001.jpg' });
    expect(photo.text).toBe('the terrace!');
    expect(chat.messages.at(-1)!.attachments[0]).toMatchObject({
      type: 'location',
      url: 'https://maps.google.com/?q=38.72,-9.14',
    });
  });

  it('derives the same ids every time, so re-imports merge', () => {
    const again = parseWhatsAppChat(ANDROID_CHAT, { fileName: 'WhatsApp Chat with Alice.txt' });
    expect(again.messages.map((m) => m.nativeId)).toEqual(chat.messages.map((m) => m.nativeId));
    expect(new Set(chat.messages.map((m) => m.nativeId)).size).toBe(chat.messages.length);
  });

  it('honours an explicit date order', () => {
    const us = parseWhatsAppChat('01/02/2024, 10:00 - Alice: hi', { fileName: 'x.txt', dateOrder: 'MDY' });
    expect(us.messages[0]!.timestamp).toBe(local(2024, 1, 2, 10, 0));
  });
});

describe('iOS export', () => {
  const chat = parseWhatsAppChat(IOS_CHAT, { fileName: 'WhatsApp Chat - Trip Crew', selfName: 'Vince' });

  it('handles brackets, 12-hour clocks, narrow spaces and month-first dates', () => {
    const midnight = chat.messages.find((m) => m.text === 'midnight message')!;
    expect(midnight.timestamp).toBe(local(2024, 3, 16, 0, 0, 1));
    expect(midnight.fromSelf).toBe(true);
  });

  it('treats left-to-right-marked notices as system messages, not as a participant', () => {
    expect(chat.isGroup).toBe(true);
    expect(chat.participants.map((p) => p.name).sort()).toEqual(['Alice', 'Bob', 'Vince']);
    const notices = chat.messages.filter((m) => m.senderId === 'system');
    expect(notices.map((m) => m.text)).toEqual([
      expect.stringContaining('end-to-end encrypted'),
      'Alice created group “Trip Crew”',
    ]);
  });

  it('recognises omitted and attached media, and calls', () => {
    const omitted = chat.messages.find((m) => m.senderName === 'Bob' && m.kind === 'media')!;
    expect(omitted.attachments).toEqual([{ type: 'image' }]);
    const attached = chat.messages.find((m) => m.senderName === 'Vince' && m.kind === 'media')!;
    expect(attached.attachments[0]).toMatchObject({
      type: 'image',
      archivePath: '00000012-PHOTO-2024-03-15-21-08-45.jpg',
    });
    const call = chat.messages.at(-1)!;
    expect([call.kind, call.senderName, call.text]).toEqual(['system', 'Alice', 'Missed voice call']);
  });
});
