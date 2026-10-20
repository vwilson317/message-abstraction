import { strToU8, zipSync } from 'fflate';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveFromBuffer, archiveFromDirectory } from '../src/importers/archive';
import { importArchive } from '../src/importers/index';
import { ANDROID_CHAT, IOS_CHAT, igThread, mojibake } from './fixtures';
import { makeHub } from './helpers';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

describe('importArchive', () => {
  it('imports an Android .txt and is idempotent on re-import', () => {
    const { hub } = makeHub();
    const file = archiveFromBuffer('WhatsApp Chat with Alice.txt', strToU8(ANDROID_CHAT));
    const first = importArchive(hub, file);
    expect(first.conversations).toEqual([
      { id: 'import:whatsapp:alice', title: 'Alice', platform: 'whatsapp', messageCount: 9, selfName: 'Vince' },
    ]);
    // The photo is referenced but this export was made without media.
    expect(first.warnings).toEqual(['1 attachment(s) in "Alice" weren\'t included in the export.']);

    const again = importArchive(hub, file);
    expect(again.conversations[0]!.messageCount).toBe(9);
    expect(hub.store.allMessages('import:whatsapp:alice').filter((m) => m.fromSelf)).toHaveLength(2);
  });

  it('imports an iOS zip with media and serves the attachment', () => {
    const { hub, media } = makeHub();
    const zip = zipSync({
      '_chat.txt': strToU8(IOS_CHAT),
      '00000012-PHOTO-2024-03-15-21-08-45.jpg': JPEG,
    });
    const summary = importArchive(hub, archiveFromBuffer('WhatsApp Chat - Trip Crew.zip', zip), { selfName: 'Vince' });
    expect(summary.conversations[0]).toMatchObject({ title: 'Trip Crew', selfName: 'Vince' });
    expect(summary.warnings).toEqual([]);

    const photo = hub.store.allMessages(summary.conversations[0]!.id).find((m) => m.attachments[0]?.url)!;
    expect(photo.attachments[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    const file = photo.attachments[0]!.url!.replace('/api/media/', '');
    expect(existsSync(media.resolve(file)!)).toBe(true);
    expect(hub.requireConversation(summary.conversations[0]!.id).isGroup).toBe(true);
  });

  it('asks you to pick yourself when it cannot tell', () => {
    const { hub } = makeHub();
    const summary = importArchive(hub, archiveFromBuffer('_chat.txt', strToU8(IOS_CHAT)));
    expect(summary.conversations[0]!.selfName).toBeNull();
    expect(summary.warnings[0]).toMatch(/Couldn't tell which participant is you/);
  });

  it('imports an extracted Instagram export folder, finding you and the media', () => {
    const { hub, dir } = makeHub();
    const root = join(dir, 'instagram-vince');
    const thread = (name: string, others: string[], messages: object[]) => {
      const threadDir = join(root, 'your_instagram_activity/messages/inbox', name);
      mkdirSync(join(threadDir, 'photos'), { recursive: true });
      writeFileSync(
        join(threadDir, 'message_1.json'),
        igThread({ title: others.join(', '), others, self: mojibake('Vincé'), path: `inbox/${name}`, messages }),
      );
      return threadDir;
    };
    const aliceDir = thread(
      'alice_1',
      ['Alice'],
      [
        { sender_name: mojibake('Vincé'), timestamp_ms: 2000, content: 'hey' },
        {
          sender_name: 'Alice',
          timestamp_ms: 1000,
          photos: [{ uri: 'your_instagram_activity/messages/inbox/alice_1/photos/p.jpg' }],
        },
      ],
    );
    writeFileSync(join(aliceDir, 'photos/p.jpg'), JPEG);
    thread('group_2', ['Bob', 'Carol'], [{ sender_name: 'Bob', timestamp_ms: 500, content: 'yo' }]);

    const summary = importArchive(hub, archiveFromDirectory(root));
    expect(summary.conversations.map((c) => [c.title, c.selfName])).toEqual([
      ['Alice', 'Vincé'],
      ['Bob, Carol', 'Vincé'],
    ]);
    const messages = hub.store.allMessages('import:instagram:inbox-alice-1');
    expect(messages[0]!.attachments[0]!.url).toMatch(/^\/api\/media\/[a-f0-9]{32}\.jpg$/);
    expect(messages[1]).toMatchObject({ fromSelf: true, senderName: 'Vincé' });
    expect(hub.requireConversation('import:instagram:inbox-group-2').isGroup).toBe(true);
  });

  it('explains what it expected when nothing matches', () => {
    const { hub } = makeHub();
    expect(() => importArchive(hub, archiveFromBuffer('notes.txt', strToU8('just some notes')))).toThrow(
      /Couldn't find a WhatsApp chat export/,
    );
  });
});
