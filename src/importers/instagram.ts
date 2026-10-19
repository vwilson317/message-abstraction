import type { Participant, Reaction } from '../core/types';
import {
  assignStableIds,
  slug,
  type ImportOptions,
  type ParsedChat,
  type ParsedMessage,
  type PendingAttachment,
} from './types';

/**
 * Parser for Instagram's "Download your information" export (JSON format).
 * Each thread lives at …/messages/<folder>/<thread>/message_N.json, newest
 * messages first, split across files for long threads.
 */

interface IgMedia {
  uri?: string;
}

interface IgMessage {
  sender_name?: string;
  timestamp_ms?: number;
  content?: string;
  photos?: IgMedia[];
  videos?: IgMedia[];
  audio_files?: IgMedia[];
  gifs?: IgMedia[];
  files?: IgMedia[];
  sticker?: IgMedia;
  share?: { link?: string; share_text?: string };
  reactions?: { reaction?: string; actor?: string }[];
  call_duration?: number;
  is_unsent?: boolean;
}

interface IgThreadFile {
  participants?: { name?: string }[];
  messages?: IgMessage[];
  title?: string;
  thread_path?: string;
}

const THREAD_FILE = /(?:^|\/)messages\/[^/]+\/([^/]+)\/message_(\d+)\.json$/;
const latin1Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Meta's exports write UTF-8 bytes as if each were a Latin-1 character
 * ("Ã©" for "é", "Ã°Ã\u009fÂ\u0098Â\u0082" for an emoji). Undo that when
 * the string decodes cleanly; leave it alone otherwise.
 */
export function fixMetaEncoding(value: string): string {
  if (!/[\u0080-ÿ]/.test(value) || /[^\u0000-ÿ]/.test(value)) return value;
  const bytes = Uint8Array.from(value, (ch) => ch.charCodeAt(0));
  try {
    return latin1Decoder.decode(bytes);
  } catch {
    return value;
  }
}

export function parseMetaJson<T>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) => (typeof value === 'string' ? fixMetaEncoding(value) : value)) as T;
}

/** Group message_N.json paths by thread directory. */
export function findInstagramThreads(paths: string[]): Map<string, string[]> {
  const threads = new Map<string, string[]>();
  for (const path of paths) {
    const match = path.match(THREAD_FILE);
    if (!match) continue;
    const dir = path.slice(0, path.lastIndexOf('/'));
    threads.set(dir, [...(threads.get(dir) ?? []), path]);
  }
  for (const files of threads.values()) {
    files.sort((a, b) => Number(a.match(THREAD_FILE)![2]) - Number(b.match(THREAD_FILE)![2]));
  }
  return threads;
}

export function looksLikeInstagramThread(text: string): boolean {
  try {
    const data = JSON.parse(text) as IgThreadFile;
    return Array.isArray(data.participants) && Array.isArray(data.messages);
  } catch {
    return false;
  }
}

/** The export's own profile record, when it was included. */
export function profileNameFromExport(text: string): string | null {
  try {
    const data = parseMetaJson<{ profile_user?: { string_map_data?: Record<string, { value?: string }> }[] }>(text);
    const fields = data.profile_user?.[0]?.string_map_data ?? {};
    return fields.Name?.value || fields.Username?.value || null;
  } catch {
    return null;
  }
}

/** The account owner is the one name present in every thread. */
export function inferSelfFromThreads(participantLists: string[][]): string | null {
  if (participantLists.length < 2) return null;
  const [first = [], ...rest] = participantLists;
  const common = first.filter((name) => rest.every((list) => list.includes(name)));
  return common.length === 1 ? common[0]! : null;
}

export function readThreadParticipants(fileText: string): string[] {
  const data = parseMetaJson<IgThreadFile>(fileText);
  return (data.participants ?? []).map((p) => p.name ?? '').filter(Boolean);
}

const REACTION_NOTICE = /^Reacted .+ to (?:your|a) message\s*$/i;
const LIKE_NOTICE = /^Liked a message$/i;
const ATTACHMENT_NOTICE = /sent an attachment\.$/i;

function attachmentsOf(m: IgMessage): PendingAttachment[] {
  const files = (list: IgMedia[] | undefined, type: PendingAttachment['type']) =>
    (list ?? [])
      .filter((f) => f.uri)
      .map((f): PendingAttachment => ({ type, archivePath: f.uri!, name: f.uri!.split('/').pop() }));
  const attachments = [
    ...files(m.photos, 'image'),
    ...files(m.videos, 'video'),
    ...files(m.audio_files, 'audio'),
    ...files(m.gifs, 'image'),
    ...files(m.files, 'document'),
    ...files(m.sticker ? [m.sticker] : undefined, 'sticker'),
  ];
  if (m.share?.link) attachments.push({ type: 'link', url: m.share.link, name: m.share.share_text || m.share.link });
  return attachments;
}

/** Parse one thread from the text of its message_N.json files (any order). */
export function parseInstagramThread(
  fileTexts: string[],
  options: ImportOptions & { threadDir: string; exportRoot?: string },
): ParsedChat {
  const files = fileTexts.map((t) => parseMetaJson<IgThreadFile>(t));
  const head = files[0] ?? {};
  const names = (head.participants ?? []).map((p) => p.name ?? '').filter(Boolean);
  const selfName = options.selfName?.trim() || null;
  const others = names.filter((n) => n !== selfName);
  const title = head.title || others.join(', ') || 'Instagram chat';

  const raw = files.flatMap((f) => f.messages ?? []).filter((m) => typeof m.timestamp_ms === 'number');
  raw.sort((a, b) => a.timestamp_ms! - b.timestamp_ms!);

  const messages: ParsedMessage[] = raw.map((m) => {
    const sender = m.sender_name ?? 'Unknown';
    const attachments = attachmentsOf(m);
    let text = m.content ?? null;
    let kind: ParsedMessage['kind'] = attachments.length ? 'media' : 'text';
    if (text && (REACTION_NOTICE.test(text) || LIKE_NOTICE.test(text))) kind = 'system';
    else if (m.call_duration !== undefined) kind = 'system';
    else if (text && ATTACHMENT_NOTICE.test(text)) {
      text = null;
      if (!attachments.length) attachments.push({ type: 'other' });
      kind = 'media';
    }
    // A shared post's "content" is often just its link again.
    if (text && m.share?.link && text.trim() === m.share.link) text = null;
    const reactions: Reaction[] = (m.reactions ?? [])
      .filter((r) => r.reaction && r.actor)
      .map((r) => ({ emoji: r.reaction!, senderId: r.actor!, senderName: r.actor! }));
    return {
      senderId: sender,
      senderName: sender,
      fromSelf: sender === selfName,
      timestamp: m.timestamp_ms!,
      kind,
      text: m.is_unsent ? null : text,
      attachments: m.is_unsent ? [] : attachments,
      reactions,
      deleted: m.is_unsent ?? false,
    };
  });
  assignStableIds(messages);

  const participants: Participant[] = names.map((name) => ({ id: name, name, isSelf: name === selfName }));
  const threadPath = head.thread_path || options.threadDir.split('/').slice(-2).join('/');

  return {
    platform: 'instagram',
    nativeId: slug(threadPath.replace(/\//g, '-')),
    title,
    isGroup: names.length > 2,
    participants,
    messages,
    // Media URIs in the export are relative to the export root.
    baseDir: options.exportRoot ?? '',
    selfName,
  };
}
