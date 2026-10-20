import { createHash } from 'node:crypto';
import type { MessageInput } from '../core/connector';
import type { Attachment, Participant, Platform } from '../core/types';

export interface PendingAttachment extends Attachment {
  /** Where the file lives in the export, relative to the chat's base directory. */
  archivePath?: string;
}

export type ParsedMessage = Omit<MessageInput, 'conversationNativeId' | 'attachments' | 'nativeId'> & {
  nativeId?: string;
  attachments: PendingAttachment[];
};

export interface ParsedChat {
  platform: Platform;
  nativeId: string;
  title: string;
  isGroup: boolean;
  participants: Participant[];
  messages: ParsedMessage[];
  /** Directory inside the archive that attachment paths are relative to. */
  baseDir: string;
  /** Who we decided the account owner is, or null if we couldn't tell. */
  selfName: string | null;
}

export interface ImportOptions {
  /** Your display name as it appears in the export. Needed to tell your messages apart. */
  selfName?: string;
  /** WhatsApp only: how dates are written, when the export is ambiguous. */
  dateOrder?: 'DMY' | 'MDY' | 'YMD';
}

/**
 * Exports carry no message ids, so derive them from content. The same export
 * imported twice, or a longer export of the same chat, yields the same ids
 * and re-importing merges instead of duplicating.
 *
 * Messages that share a timestamp (minute-precision Android exports) are
 * nudged apart by a millisecond each so their order survives sorting.
 */
export function assignStableIds(messages: ParsedMessage[]): void {
  const perTimestamp = new Map<number, number>();
  const perHash = new Map<string, number>();
  for (const m of messages) {
    const base = m.timestamp;
    const offset = perTimestamp.get(base) ?? 0;
    perTimestamp.set(base, offset + 1);
    m.timestamp = base + offset;
    const files = m.attachments.map((a) => a.archivePath ?? a.type).join(',');
    const hash = createHash('sha1')
      .update(`${base}\0${m.senderName}\0${m.text ?? ''}\0${files}`)
      .digest('hex')
      .slice(0, 20);
    const seen = perHash.get(hash) ?? 0;
    perHash.set(hash, seen + 1);
    m.nativeId = seen === 0 ? hash : `${hash}-${seen}`;
  }
}

export function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'chat'
  );
}
