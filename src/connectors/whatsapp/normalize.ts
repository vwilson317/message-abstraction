import {
  getContentType,
  type WAMessageUpdate,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  toNumber,
  type WAMessage,
  type WAMessageKey,
} from 'baileys';
import type { MessageInput, MessagePatch } from '../../core/connector';
import type { Attachment, DeliveryStatus, MessageKind } from '../../core/types';

export interface JidResolver {
  /** The linked account's own phone-number JID, once known. */
  selfJid: string | null;
  /** Map a LID (`…@lid`) to its phone-number JID when the mapping is known. */
  lidToPn(lid: string): string | undefined;
  /** Best display name for a user JID, if we know one. */
  nameFor(jid: string): string | undefined;
}

export type Normalized = { type: 'message'; input: MessageInput } | { type: 'patch'; patch: MessagePatch };

/** Chats we never show: status updates, channels and broadcast lists. */
export function isIgnoredJid(jid: string | null | undefined): boolean {
  return !jid || jid === 'status@broadcast' || !!isJidBroadcast(jid) || !!isJidNewsletter(jid);
}

/**
 * WhatsApp is migrating 1:1 chats from phone-number JIDs to opaque LIDs. Prefer
 * the phone-number form when we can, so one person doesn't become two chats.
 */
export function canonicalJid(jid: string, alt: string | null | undefined, resolver: JidResolver): string {
  const normal = jidNormalizedUser(jid);
  if (!isLidUser(normal)) return normal;
  if (alt && !isLidUser(alt)) return jidNormalizedUser(alt);
  return resolver.lidToPn(normal) ?? normal;
}

export function chatJidOf(key: WAMessageKey, resolver: JidResolver): string | null {
  if (isIgnoredJid(key.remoteJid)) return null;
  return canonicalJid(key.remoteJid!, key.remoteJidAlt, resolver);
}

export function phoneLabel(jid: string): string {
  const [user] = jid.split('@');
  return user && /^\d+$/.test(user) ? `+${user}` : (user ?? jid);
}

function senderOf(key: WAMessageKey, chatJid: string, resolver: JidResolver): string {
  if (key.fromMe) return resolver.selfJid ?? 'me';
  if (isJidGroup(chatJid) && key.participant) return canonicalJid(key.participant, key.participantAlt, resolver);
  return chatJid;
}

function deliveryStatus(status: number | null | undefined): DeliveryStatus | null {
  switch (status) {
    case proto.WebMessageInfo.Status.ERROR:
      return 'failed';
    case proto.WebMessageInfo.Status.PENDING:
      return 'pending';
    case proto.WebMessageInfo.Status.SERVER_ACK:
      return 'sent';
    case proto.WebMessageInfo.Status.DELIVERY_ACK:
      return 'delivered';
    case proto.WebMessageInfo.Status.READ:
    case proto.WebMessageInfo.Status.PLAYED:
      return 'read';
    default:
      return null;
  }
}

interface Body {
  kind: MessageKind;
  text: string | null;
  attachments: Attachment[];
  replyTo: string | null;
}

/** Content types that carry no user-visible message. */
const SILENT_TYPES = new Set<string>([
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollUpdateMessage',
  'keepInChatMessage',
  'encReactionMessage',
  'encEventResponseMessage',
  'pinInChatMessage',
  'callLogMesssage',
]);

export function bodyOf(content: proto.IMessage): Body | null {
  const type = getContentType(content);
  if (!type || SILENT_TYPES.has(type)) return null;
  const media = (
    attachment: Attachment,
    caption: string | null | undefined,
    ctx?: proto.IContextInfo | null,
  ): Body => ({
    kind: 'media',
    text: caption || null,
    attachments: [attachment],
    replyTo: ctx?.stanzaId ?? null,
  });

  switch (type) {
    case 'conversation':
      return { kind: 'text', text: content.conversation ?? '', attachments: [], replyTo: null };
    case 'extendedTextMessage': {
      const m = content.extendedTextMessage!;
      return { kind: 'text', text: m.text ?? '', attachments: [], replyTo: m.contextInfo?.stanzaId ?? null };
    }
    case 'imageMessage': {
      const m = content.imageMessage!;
      return media({ type: 'image', mimeType: m.mimetype ?? undefined }, m.caption, m.contextInfo);
    }
    case 'videoMessage': {
      const m = content.videoMessage!;
      return media({ type: 'video', mimeType: m.mimetype ?? undefined }, m.caption, m.contextInfo);
    }
    case 'ptvMessage': {
      const m = content.ptvMessage!;
      return media({ type: 'video', mimeType: m.mimetype ?? undefined }, m.caption, m.contextInfo);
    }
    case 'audioMessage': {
      const m = content.audioMessage!;
      return media({ type: 'audio', mimeType: m.mimetype ?? undefined }, null, m.contextInfo);
    }
    case 'stickerMessage': {
      const m = content.stickerMessage!;
      return media({ type: 'sticker', mimeType: m.mimetype ?? undefined }, null, m.contextInfo);
    }
    case 'documentMessage': {
      const m = content.documentMessage!;
      const attachment: Attachment = { type: 'document', mimeType: m.mimetype ?? undefined };
      if (m.fileName) attachment.name = m.fileName;
      return media(attachment, m.caption, m.contextInfo);
    }
    case 'locationMessage':
    case 'liveLocationMessage': {
      const m = content.locationMessage ?? content.liveLocationMessage!;
      const url = `https://maps.google.com/?q=${m.degreesLatitude},${m.degreesLongitude}`;
      const name = 'name' in m && m.name ? m.name : undefined;
      return media({ type: 'location', url, ...(name && { name }) }, null, m.contextInfo);
    }
    case 'contactMessage': {
      const m = content.contactMessage!;
      return media({ type: 'contact', name: m.displayName ?? 'Contact' }, null, m.contextInfo);
    }
    case 'contactsArrayMessage': {
      const m = content.contactsArrayMessage!;
      return media(
        { type: 'contact', name: m.displayName ?? `${m.contacts?.length ?? 0} contacts` },
        null,
        m.contextInfo,
      );
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const m = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3!;
      const options = (m.options ?? []).map((o) => `• ${o.optionName}`).join('\n');
      return { kind: 'text', text: `📊 ${m.name ?? 'Poll'}\n${options}`.trim(), attachments: [], replyTo: null };
    }
    default:
      return { kind: 'system', text: `Unsupported message (${type})`, attachments: [], replyTo: null };
  }
}

/**
 * Turn one Baileys message into either a new message or a change to an existing
 * one (reactions, edits and deletes all arrive as messages of their own).
 */
export function normalizeMessage(msg: WAMessage, resolver: JidResolver): Normalized | null {
  const chatJid = chatJidOf(msg.key, resolver);
  if (!chatJid || !msg.key.id) return null;
  const senderId = senderOf(msg.key, chatJid, resolver);
  const senderName = msg.key.fromMe ? 'You' : (resolver.nameFor(senderId) ?? msg.pushName ?? phoneLabel(senderId));
  const timestamp = toNumber(msg.messageTimestamp) * 1000 || Date.now();

  const base = {
    conversationNativeId: chatJid,
    nativeId: msg.key.id,
    senderId,
    senderName,
    fromSelf: !!msg.key.fromMe,
    timestamp,
    status: msg.key.fromMe ? deliveryStatus(msg.status) : null,
  };

  if (msg.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
    return { type: 'message', input: { ...base, kind: 'text', text: null, deleted: true } };
  }

  const content = normalizeMessageContent(msg.message);
  if (!content) return null;

  if (content.reactionMessage) {
    const r = content.reactionMessage;
    if (!r.key?.id) return null;
    return {
      type: 'patch',
      patch: {
        conversationNativeId: chatJid,
        nativeId: r.key.id,
        reaction: { emoji: r.text ?? '', senderId, senderName },
      },
    };
  }

  if (content.protocolMessage) {
    const p = content.protocolMessage;
    if (!p.key?.id) return null;
    if (p.type === proto.Message.ProtocolMessage.Type.REVOKE) {
      return { type: 'patch', patch: { conversationNativeId: chatJid, nativeId: p.key.id, deleted: true } };
    }
    if (p.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && p.editedMessage) {
      const edited = bodyOf(normalizeMessageContent(p.editedMessage) ?? {});
      if (!edited) return null;
      return {
        type: 'patch',
        patch: { conversationNativeId: chatJid, nativeId: p.key.id, text: edited.text, edited: true },
      };
    }
    return null;
  }

  const body = bodyOf(content);
  if (!body) return null;

  const reactions = (msg.reactions ?? [])
    .filter((r) => r.text && r.key)
    .map((r) => {
      const reactor = r.key!.fromMe ? (resolver.selfJid ?? 'me') : senderOf(r.key!, chatJid, resolver);
      return {
        emoji: r.text!,
        senderId: reactor,
        senderName: r.key!.fromMe ? 'You' : (resolver.nameFor(reactor) ?? phoneLabel(reactor)),
      };
    });

  return {
    type: 'message',
    input: {
      ...base,
      kind: body.kind,
      text: body.text,
      attachments: body.attachments,
      reactions,
      replyToNativeId: body.replyTo,
    },
  };
}

/**
 * `messages.update` carries receipts, deletes and edits for messages we already
 * have. It also fires for media re-uploads with the full message attached, which
 * must not be mistaken for an edit, so only `editedMessage` counts as one.
 */
export function normalizeUpdate(
  key: WAMessageKey,
  update: WAMessageUpdate['update'],
  resolver: JidResolver,
): MessagePatch[] {
  const chatJid = chatJidOf(key, resolver);
  if (!chatJid || !key.id) return [];
  const target = { conversationNativeId: chatJid, nativeId: key.id };
  const patches: MessagePatch[] = [];
  const status = deliveryStatus(update.status);
  if (status) patches.push({ ...target, status });
  if (update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) patches.push({ ...target, deleted: true });
  const edited = update.message?.editedMessage?.message;
  if (edited) {
    const body = bodyOf(normalizeMessageContent(edited) ?? {});
    if (body) patches.push({ ...target, text: body.text, edited: true });
  }
  return patches;
}

/** Media types worth downloading automatically for live messages. */
export function downloadableMedia(msg: WAMessage, maxBytes: number): { mimeType?: string; fileName?: string } | null {
  const content = normalizeMessageContent(msg.message);
  const media = content?.imageMessage ?? content?.stickerMessage ?? content?.audioMessage ?? null;
  if (!media) return null;
  const size = toNumber(media.fileLength ?? 0);
  if (size > maxBytes) return null;
  return { mimeType: media.mimetype ?? undefined };
}
