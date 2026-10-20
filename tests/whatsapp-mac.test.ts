import { closeSync, mkdirSync, openSync, ftruncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { WhatsAppMacConnector } from '../src/connectors/whatsapp-mac/connector';
import { decodeReactions } from '../src/connectors/whatsapp-mac/protobuf';
import { appleDateToMs } from '../src/connectors/whatsapp-mac/reader';
import { makeHub } from './helpers';

/** A cut-down ChatStorage.sqlite with the Core Data layout WhatsApp uses on Mac and iPhone. */
const SCHEMA = `
CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACTJID VARCHAR,
  ZPARTNERNAME VARCHAR, ZSESSIONTYPE INTEGER, ZUNREADCOUNT INTEGER, ZLASTMESSAGEDATE TIMESTAMP, ZREMOVED INTEGER,
  ZHIDDEN INTEGER);
CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHATSESSION INTEGER, ZISFROMME INTEGER,
  ZMESSAGEDATE TIMESTAMP, ZFROMJID VARCHAR, ZTOJID VARCHAR, ZTEXT VARCHAR, ZMESSAGETYPE INTEGER, ZSTANZAID VARCHAR,
  ZPUSHNAME VARCHAR, ZGROUPMEMBER INTEGER, ZMEDIAITEM INTEGER, ZSORT INTEGER, ZPARENTMESSAGE INTEGER, ZMESSAGEINFO INTEGER);
CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZMEMBERJID VARCHAR, ZCONTACTNAME VARCHAR,
  ZFIRSTNAME VARCHAR, ZISACTIVE INTEGER);
CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMESSAGE INTEGER, ZMEDIALOCALPATH VARCHAR, ZTITLE VARCHAR,
  ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZVCARDNAME VARCHAR);
CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, ZJID VARCHAR, ZPUSHNAME VARCHAR);
CREATE TABLE ZWAMESSAGEINFO (Z_PK INTEGER PRIMARY KEY, ZRECEIPTINFO BLOB);
`;

const ALICE = '15551230000@s.whatsapp.net';
const BOB = '15554560000@s.whatsapp.net';
const CAROL = '15557890000@s.whatsapp.net';
const DANA = '15550001111@s.whatsapp.net';
const ERIN = '15552223333@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
/** 2024-03-15 21:00:00 UTC in Apple's epoch. */
const T0 = 732229200;

// ── A tiny protobuf encoder, to build ZRECEIPTINFO blobs ────────────────────
type Field = [number, number | string | Uint8Array];
function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}
function encode(fields: Field[]): Uint8Array {
  const bytes: number[] = [];
  for (const [field, value] of fields) {
    if (typeof value === 'number') bytes.push(...varint(field * 8), ...varint(value));
    else {
      const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      bytes.push(...varint(field * 8 + 2), ...varint(data.length), ...data);
    }
  }
  return Uint8Array.from(bytes);
}
const REACTIONS = encode([
  [3, 1_710_536_400],
  [
    7,
    encode([
      [
        1,
        encode([
          [1, 'R1'],
          [2, ALICE],
          [3, '❤️'],
          [4, 1_710_536_460_000],
        ]),
      ],
      [
        1,
        encode([
          [1, 'R2'],
          [3, '👍'],
          [4, 1_710_536_470_000],
          [6, 1],
        ]),
      ],
      [
        1,
        encode([
          [1, 'R3'],
          [2, BOB],
          [4, 1_710_536_480_000],
        ]),
      ], // withdrawn: no emoji
    ]),
  ],
]);

let writers: DatabaseSync[] = [];
afterEach(() => {
  for (const w of writers) w.close();
  writers = [];
});

function buildContainer(dir: string): DatabaseSync {
  const media = join(dir, 'Message/Media', ALICE, 'a');
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, 'photo.jpg'), new Uint8Array([0xff, 0xd8, 0xff]));
  // A sparse file: size but no blocks, like an iCloud placeholder that blocks when read.
  const stub = openSync(join(media, 'stub.jpg'), 'w');
  ftruncateSync(stub, 4096);
  closeSync(stub);

  const db = new DatabaseSync(join(dir, 'ChatStorage.sqlite'));
  writers.push(db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO ZWACHATSESSION VALUES
      (1, 0, 0, '${ALICE}', 'Alice', 0, -1, ${T0 + 400}, 0, 0),
      (2, 0, 0, '${GROUP}', 'Trip Crew', 1, 0, ${T0 + 300}, 0, 0),
      (3, 0, 0, 'status@broadcast', NULL, 3, 0, ${T0}, 0, 0),
      (4, 0, 0, '15559999999@s.whatsapp.net', 'Hidden', 0, 0, ${T0}, 0, 1),
      (5, 0, 0, '777@lid', NULL, 0, 4, ${T0 + 500}, 0, 0);
    INSERT INTO ZWAGROUPMEMBER VALUES
      (1, 2, '${BOB}', NULL, NULL, 1),
      (2, 2, '${CAROL}', NULL, NULL, 1),
      (3, 2, '888@lid', NULL, NULL, 1);
    INSERT INTO ZWAPROFILEPUSHNAME VALUES (1, '${CAROL}', 'Carol ✨');
    INSERT INTO ZWAMESSAGEINFO VALUES (1, X'${Buffer.from(REACTIONS).toString('hex')}');
    INSERT INTO ZWAMEDIAITEM VALUES
      (1, 3, 'Media/${ALICE}/a/photo.jpg', 'look at this', NULL, NULL, NULL),
      (2, 4, NULL, NULL, 38.72, -9.14, NULL),
      (3, 9, '../../../../etc/passwd', NULL, NULL, NULL, NULL),
      (4, 12, 'Media/${ALICE}/a/never-downloaded.jpg', NULL, NULL, NULL, NULL),
      (5, 13, 'Media/${ALICE}/a/stub.jpg', NULL, NULL, NULL, NULL);
    INSERT INTO ZWAMESSAGE VALUES
      (1, 0, 0, 1, 0, ${T0}, '${ALICE}', NULL, 'Morning!', 0, 'A1', NULL, NULL, NULL, 1, NULL, 1),
      (2, 0, 0, 1, 1, ${T0 + 60}, NULL, '${ALICE}', 'Morning :)', 0, 'A2', NULL, NULL, NULL, 2, 1, NULL),
      (3, 0, 0, 1, 0, ${T0 + 120}, '${ALICE}', NULL, NULL, 1, 'A3', NULL, NULL, 1, 3, NULL, NULL),
      (4, 0, 0, 1, 0, ${T0 + 180}, '${ALICE}', NULL, NULL, 5, 'A4', NULL, NULL, 2, 4, NULL, NULL),
      (5, 0, 0, 1, 1, ${T0 + 240}, NULL, '${ALICE}', NULL, 14, 'A5', NULL, NULL, NULL, 5, NULL, NULL),
      (6, 0, 0, 2, 0, ${T0 + 250}, '${GROUP}', NULL, NULL, 6, 'G0', NULL, NULL, NULL, 1, NULL, NULL),
      (7, 0, 0, 2, 0, ${T0 + 260}, '${GROUP}', NULL, 'who is booking?', 0, 'G1', NULL, 1, NULL, 2, NULL, NULL),
      (8, 0, 0, 2, 0, ${T0 + 270}, '${GROUP}', NULL, 'me!', 0, 'G2', NULL, 2, NULL, 3, NULL, NULL),
      (9, 0, 0, 2, 0, ${T0 + 280}, '${GROUP}', NULL, NULL, 8, 'G3', NULL, 2, 3, 4, NULL, NULL),
      (10, 0, 0, 3, 0, ${T0 + 290}, 'status@broadcast', NULL, 'a status update', 0, 'S1', NULL, NULL, NULL, 1, NULL, NULL),
      (11, 0, 0, 1, 0, ${T0 + 300}, '${ALICE}', NULL, NULL, 99, 'A6', NULL, NULL, NULL, 6, NULL, NULL),
      (12, 0, 0, 1, 0, ${T0 + 310}, '${ALICE}', NULL, NULL, 1, 'A7', NULL, NULL, 4, 7, NULL, NULL),
      (13, 0, 0, 1, 0, ${T0 + 320}, '${ALICE}', NULL, NULL, 1, 'A8', NULL, NULL, 5, 8, NULL, NULL),
      (14, 0, 0, 1, 0, ${T0}, '${ALICE}', NULL, 'stale copy', 0, 'A1', NULL, NULL, NULL, -1, NULL, NULL),
      (15, 0, 0, 2, 0, ${T0 + 290}, '${GROUP}', NULL, 'count me in', 0, 'G4', NULL, 3, NULL, 5, NULL, NULL),
      (16, 0, 0, 5, 0, ${T0 + 500}, '777@lid', NULL, 'hi from a LID chat', 0, 'D1', NULL, NULL, NULL, 1, NULL, NULL);
  `);

  const contacts = new DatabaseSync(join(dir, 'ContactsV2.sqlite'));
  contacts.exec(`CREATE TABLE ZWAADDRESSBOOKCONTACT (Z_PK INTEGER PRIMARY KEY, ZWHATSAPPID VARCHAR, ZFULLNAME VARCHAR, ZLID VARCHAR);
    INSERT INTO ZWAADDRESSBOOKCONTACT VALUES
      (1, '${BOB}', 'Bob Saved', NULL),
      (2, '${DANA}', 'Dana Saved', NULL),
      (3, '${ERIN}', 'Erin Saved', '888');`);
  contacts.close();

  const lid = new DatabaseSync(join(dir, 'LID.sqlite'));
  lid.exec(`CREATE TABLE ZWAZACCOUNT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER VARCHAR, ZPHONENUMBER VARCHAR, ZDISPLAYNAME VARCHAR);
    INSERT INTO ZWAZACCOUNT VALUES (1, '777@lid', '+1 555 000 1111', NULL);`);
  lid.close();
  return db;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function setup() {
  const ctx = makeHub();
  const containerDir = join(ctx.dir, 'whatsapp-container');
  const writer = buildContainer(containerDir);
  const connector = new WhatsAppMacConnector({ containerDir, pollMs: 25 });
  ctx.hub.register(connector);
  await ctx.hub.startConnector('whatsapp-mac');
  return { ...ctx, writer, connector, containerDir };
}

describe('appleDateToMs', () => {
  it('converts Core Data seconds-since-2001 to epoch milliseconds and drops sentinels', () => {
    expect(appleDateToMs(T0)).toBe(Date.UTC(2024, 2, 15, 21, 0, 0));
    expect(appleDateToMs(null)).toBeNull();
    expect(appleDateToMs(0)).toBeNull();
  });
});

describe('decodeReactions', () => {
  it('reads reactions from ZRECEIPTINFO, skipping withdrawn ones', () => {
    expect(decodeReactions(REACTIONS)).toEqual([
      { senderJid: ALICE, emoji: '❤️' },
      { senderJid: null, emoji: '👍' },
    ]);
    expect(decodeReactions(Uint8Array.from([0xff, 0xff]))).toEqual([]);
  });
});

describe('WhatsAppMacConnector', () => {
  it('mirrors chats with the app’s unread counts, skipping status, hidden chats and duplicates', async () => {
    const { hub, connector } = await setup();
    expect(hub.connectorStatuses()[0]).toMatchObject({
      state: 'connected',
      detail: expect.stringContaining('3 chats'),
    });
    const titles = hub.store.listConversations().map((c) => [c.title, c.isGroup, c.unreadCount]);
    expect(titles).toEqual([
      ['Dana Saved', false, 4], // a LID chat, folded into the phone-number identity
      ['Alice', false, 1], // -1 = marked unread
      ['Trip Crew', true, 0],
    ]);
    expect(hub.store.getConversation(`whatsapp-mac:${DANA}`)?.messageCount).toBe(1);
    const group = hub.requireConversation(`whatsapp-mac:${GROUP}`);
    expect(group.participants.map((p) => [p.name, p.isSelf])).toEqual([
      ['Bob Saved', false],
      ['Carol ✨', false],
      ['Erin Saved', false],
      ['You', true],
    ]);
    await connector.stop();
  });

  it('maps text, media, locations, deletes, replies and reactions', async () => {
    const { hub, connector, containerDir } = await setup();
    const messages = hub.store.allMessages(`whatsapp-mac:${ALICE}`);
    expect(messages.map((m) => [m.nativeId, m.senderName, m.fromSelf, m.kind, m.text, m.deleted])).toEqual([
      ['A1', 'Alice', false, 'text', 'Morning!', false], // not the ZSORT < 0 "stale copy"
      ['me_A2', 'You', true, 'text', 'Morning :)', false],
      ['A3', 'Alice', false, 'media', 'look at this', false],
      ['A4', 'Alice', false, 'media', null, false],
      ['me_A5', 'You', true, 'text', null, true],
      ['A7', 'Alice', false, 'media', null, false],
      ['A8', 'Alice', false, 'media', null, false],
    ]);
    expect(messages[0]!.timestamp).toBe(Date.UTC(2024, 2, 15, 21, 0, 0));
    expect(messages[0]!.reactions).toEqual([
      { emoji: '❤️', senderId: ALICE, senderName: 'Alice' },
      { emoji: '👍', senderId: 'me', senderName: 'You' },
    ]);
    expect(messages[1]!.replyToNativeId).toBe('A1');
    expect(messages[2]!.attachments).toEqual([{ type: 'image', url: '/api/connectors/whatsapp-mac/media/1' }]);
    expect(messages[3]!.attachments).toEqual([{ type: 'location', url: 'https://maps.google.com/?q=38.72,-9.14' }]);
    // Not downloaded, and an iCloud-style stub: neither gets a link.
    expect(messages[5]!.attachments).toEqual([{ type: 'image' }]);
    expect(messages[6]!.attachments).toEqual([{ type: 'image' }]);

    expect(hub.connectorMediaFile('whatsapp-mac', '1')).toBe(join(containerDir, 'Message/Media', ALICE, 'a/photo.jpg'));
    expect(hub.connectorMediaFile('whatsapp-mac', '3')).toBeNull(); // path traversal
    expect(hub.connectorMediaFile('whatsapp-mac', '5')).toBeNull(); // dataless stub
    expect(hub.connectorMediaFile('whatsapp-mac', 'x')).toBeNull();
    await connector.stop();
  });

  it('names group senders from contacts (LIDs included), then member records, then push names', async () => {
    const { hub, connector } = await setup();
    const messages = hub.store.allMessages(`whatsapp-mac:${GROUP}`);
    expect(messages.map((m) => [m.senderName, m.senderId, m.text ?? m.attachments[0]?.type])).toEqual([
      ['Bob Saved', BOB, 'who is booking?'],
      ['Carol ✨', CAROL, 'me!'],
      ['Carol ✨', CAROL, 'document'],
      ['Erin Saved', ERIN, 'count me in'],
    ]);
    await connector.stop();
  });

  it('picks up new messages, edits and deletes while WhatsApp is running', async () => {
    const { hub, connector, writer } = await setup();
    const id = `whatsapp-mac:${ALICE}:A9`;
    writer.exec(`INSERT INTO ZWAMESSAGE VALUES
      (20, 0, 0, 1, 0, ${T0 + 600}, '${ALICE}', NULL, 'are you there?', 0, 'A9', NULL, NULL, NULL, 9, NULL, NULL);
      UPDATE ZWACHATSESSION SET ZUNREADCOUNT = 3 WHERE Z_PK = 1;`);
    await until(() => hub.store.getMessage(id) !== undefined);
    expect(hub.requireConversation(`whatsapp-mac:${ALICE}`)).toMatchObject({
      unreadCount: 3,
      lastMessagePreview: 'are you there?',
    });

    writer.exec(`UPDATE ZWAMESSAGE SET ZTEXT = 'are you there??' WHERE Z_PK = 20`);
    await until(() => hub.store.getMessage(id)?.text === 'are you there??');
    expect(hub.store.getMessage(id)).toMatchObject({ edited: true });

    writer.exec(`UPDATE ZWAMESSAGE SET ZTEXT = 'are you there???' WHERE Z_PK = 20`);
    await until(() => hub.store.getMessage(id)?.text === 'are you there???');

    writer.exec(`UPDATE ZWAMESSAGE SET ZTEXT = NULL, ZMESSAGETYPE = 14 WHERE Z_PK = 20`);
    await until(() => hub.store.getMessage(id)?.deleted === true);
    await connector.stop();
  });

  it('does not rewrite anything when it re-reads unchanged data', async () => {
    const { hub, connector, events } = await setup();
    await connector.stop();
    const before = events.length;
    await hub.startConnector('whatsapp-mac'); // a full re-read, as after a restart
    const messageEvents = events
      .slice(before)
      .filter((e) => e.type === 'message.upserted' || e.type === 'messages.bulk');
    expect(messageEvents).toEqual([]);
    await connector.stop();
  });

  it('refuses a store whose layout it does not recognise', async () => {
    const ctx = makeHub();
    const containerDir = join(ctx.dir, 'odd');
    mkdirSync(containerDir);
    const db = new DatabaseSync(join(containerDir, 'ChatStorage.sqlite'));
    db.exec(
      'CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID VARCHAR); CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY);',
    );
    db.close();
    ctx.hub.register(new WhatsAppMacConnector({ containerDir, pollMs: 25 }));
    await ctx.hub.startConnector('whatsapp-mac');
    expect(ctx.hub.connectorStatuses()[0]).toMatchObject({
      state: 'error',
      detail: expect.stringContaining('ZWACHATSESSION.ZSESSIONTYPE'),
    });
  });

  it('asks for setup when WhatsApp Desktop isn’t installed', async () => {
    const { hub, dir } = makeHub();
    const connector = new WhatsAppMacConnector({ containerDir: join(dir, 'missing'), pollMs: 25 });
    hub.register(connector);
    expect(await connector.shouldAutoStart()).toBe(false);
    await hub.startConnector('whatsapp-mac');
    expect(hub.connectorStatuses()[0]).toMatchObject({
      state: 'needs_setup',
      detail: expect.stringContaining('wasn’t found'),
    });
  });
});
