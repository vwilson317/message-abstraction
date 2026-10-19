import { proto, type WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import {
  canonicalJid,
  normalizeMessage,
  normalizeUpdate,
  type JidResolver,
} from '../src/connectors/whatsapp/normalize';

const ALICE = '15551230000@s.whatsapp.net';
const ALICE_LID = '987654321@lid';
const GROUP = '120363000000000000@g.us';
const ME = '15559990000@s.whatsapp.net';

const resolver: JidResolver = {
  selfJid: ME,
  lidToPn: (lid) => (lid === ALICE_LID ? ALICE : undefined),
  nameFor: (jid) => (jid === ALICE ? 'Alice (saved)' : undefined),
};

const wa = (partial: Partial<WAMessage> & { message?: proto.IMessage }): WAMessage => ({
  key: { remoteJid: ALICE, fromMe: false, id: 'ABC' },
  messageTimestamp: 1_700_000_000,
  ...partial,
});

describe('canonicalJid', () => {
  it('prefers phone-number JIDs over LIDs', () => {
    expect(canonicalJid(ALICE_LID, '15551230000@s.whatsapp.net', resolver)).toBe(ALICE);
    expect(canonicalJid(ALICE_LID, undefined, resolver)).toBe(ALICE);
    expect(canonicalJid('111@lid', undefined, resolver)).toBe('111@lid');
    expect(canonicalJid('15551230000:12@s.whatsapp.net', undefined, resolver)).toBe(ALICE);
  });
});

describe('normalizeMessage', () => {
  it('maps a plain text message', () => {
    const result = normalizeMessage(wa({ message: { conversation: 'hi' }, pushName: 'Ali' }), resolver);
    expect(result).toEqual({
      type: 'message',
      input: {
        conversationNativeId: ALICE,
        nativeId: 'ABC',
        senderId: ALICE,
        senderName: 'Alice (saved)',
        fromSelf: false,
        timestamp: 1_700_000_000_000,
        status: null,
        kind: 'text',
        text: 'hi',
        attachments: [],
        reactions: [],
        replyToNativeId: null,
      },
    });
  });

  it('unwraps ephemeral messages and keeps reply context', () => {
    const result = normalizeMessage(
      wa({
        message: {
          ephemeralMessage: {
            message: { extendedTextMessage: { text: 'replying', contextInfo: { stanzaId: 'PREV' } } },
          },
        },
      }),
      resolver,
    );
    expect(result?.type === 'message' && [result.input.text, result.input.replyToNativeId]).toEqual([
      'replying',
      'PREV',
    ]);
  });

  it('maps media with captions, from a LID group participant', () => {
    const result = normalizeMessage(
      wa({
        key: { remoteJid: GROUP, fromMe: false, id: 'IMG', participant: ALICE_LID },
        message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } },
      }),
      resolver,
    );
    expect(result?.type === 'message' && result.input).toMatchObject({
      conversationNativeId: GROUP,
      senderId: ALICE,
      kind: 'media',
      text: 'look',
      attachments: [{ type: 'image', mimeType: 'image/jpeg' }],
    });
  });

  it('maps own messages with delivery status', () => {
    const result = normalizeMessage(
      wa({
        key: { remoteJid: ALICE, fromMe: true, id: 'OUT' },
        status: proto.WebMessageInfo.Status.READ,
        message: { conversation: 'yo' },
      }),
      resolver,
    );
    expect(result?.type === 'message' && result.input).toMatchObject({
      senderId: ME,
      senderName: 'You',
      fromSelf: true,
      status: 'read',
    });
  });

  it('turns reactions, revokes and edits into patches', () => {
    const reaction = normalizeMessage(
      wa({ message: { reactionMessage: { key: { id: 'TARGET' }, text: '❤️' } } }),
      resolver,
    );
    expect(reaction).toEqual({
      type: 'patch',
      patch: {
        conversationNativeId: ALICE,
        nativeId: 'TARGET',
        reaction: { emoji: '❤️', senderId: ALICE, senderName: 'Alice (saved)' },
      },
    });

    const revoke = normalizeMessage(
      wa({ message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'TARGET' } } } }),
      resolver,
    );
    expect(revoke).toEqual({
      type: 'patch',
      patch: { conversationNativeId: ALICE, nativeId: 'TARGET', deleted: true },
    });

    const edit = normalizeMessage(
      wa({
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            key: { id: 'TARGET' },
            editedMessage: { conversation: 'fixed typo' },
          },
        },
      }),
      resolver,
    );
    expect(edit).toEqual({
      type: 'patch',
      patch: { conversationNativeId: ALICE, nativeId: 'TARGET', text: 'fixed typo', edited: true },
    });
  });

  it('ignores status updates, channels and protocol noise', () => {
    expect(
      normalizeMessage(
        wa({ key: { remoteJid: 'status@broadcast', id: 'S' }, message: { conversation: 'x' } }),
        resolver,
      ),
    ).toBeNull();
    expect(
      normalizeMessage(wa({ key: { remoteJid: '123@newsletter', id: 'N' }, message: { conversation: 'x' } }), resolver),
    ).toBeNull();
    expect(normalizeMessage(wa({ message: { senderKeyDistributionMessage: {} } }), resolver)).toBeNull();
  });
});

describe('normalizeUpdate', () => {
  const key = { remoteJid: ALICE, fromMe: true, id: 'OUT' };
  const target = { conversationNativeId: ALICE, nativeId: 'OUT' };

  it('maps receipts', () => {
    expect(normalizeUpdate(key, { status: proto.WebMessageInfo.Status.DELIVERY_ACK }, resolver)).toEqual([
      { ...target, status: 'delivered' },
    ]);
    expect(normalizeUpdate(key, { status: proto.WebMessageInfo.Status.ERROR }, resolver)).toEqual([
      { ...target, status: 'failed' },
    ]);
  });

  it('maps a revoke delivered as a stub', () => {
    expect(
      normalizeUpdate(key, { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE }, resolver),
    ).toEqual([{ ...target, deleted: true }]);
  });

  it('maps edits, which arrive wrapped in editedMessage', () => {
    const update = { message: { editedMessage: { message: { conversation: 'new text' } } } };
    expect(normalizeUpdate(key, update, resolver)).toEqual([{ ...target, text: 'new text', edited: true }]);
  });

  it('does not treat a media re-upload as an edit', () => {
    const update = { message: { imageMessage: { caption: 'same', mimetype: 'image/jpeg' } } };
    expect(normalizeUpdate(key, update, resolver)).toEqual([]);
  });
});
