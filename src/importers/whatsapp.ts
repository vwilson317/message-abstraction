import { basename } from 'node:path';
import type { AttachmentType, Participant } from '../core/types';
import {
  assignStableIds,
  slug,
  type ImportOptions,
  type ParsedChat,
  type ParsedMessage,
  type PendingAttachment,
} from './types';

/**
 * Parser for WhatsApp's "Export chat" text files. The format differs by phone
 * OS and locale, so we accept both layouts and work out the date order from
 * the data itself:
 *
 *   iOS:     [15/03/2024, 21:04:13] Alice: hi
 *            [3/15/24, 9:04:13 PM] Alice: ‎image omitted
 *   Android: 15/03/2024, 21:04 - Alice: hi
 *            3/15/24, 9:04 PM - Alice: IMG-20240315-WA0001.jpg (file attached)
 */

const DATE = String.raw`(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})`;
const TIME = String.raw`(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s?([AaPp])\.?\s?[Mm]\.?)?`;
const IOS_HEADER = new RegExp(String.raw`^\[${DATE},?\s${TIME}\]\s(.*)$`);
const ANDROID_HEADER = new RegExp(String.raw`^${DATE},?\s${TIME}\s[-–]\s(.*)$`);
const SENDER = /^(.{1,60}?): (.*)$/;

const LRM = '‎';
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

const DELETED = /^(?:This message was deleted|You deleted this message)\.?$/i;
const EDITED_SUFFIX = /\s*<This message was edited>$/i;
const MEDIA_OMITTED = /^<Media omitted>$/i;
const TYPE_OMITTED = /^(?:(.+?)\s+•.*?\s+)?(image|video|audio|sticker|GIF|document|Contact card) omitted$/i;
const IOS_ATTACHED = /^<(?:attached|anexado|adjunto|Anhang|pièce jointe)\s?: (.+)>$/i;
const ANDROID_ATTACHED =
  /^(.+?\.\w{2,5}) \((?:file attached|arquivo anexado|archivo adjunto|Datei angehängt|fichier joint)\)$/i;
const LOCATION = /^location: (https?:\/\/\S+)$/i;
const CALL = /^(?:Missed )?(?:group )?(?:voice|video) call\b/i;
const SYSTEM_PHRASES = [
  /end-to-end encrypted/i,
  /\bcreated (?:the )?group\b/i,
  /\b(?:added|removed) /i,
  /\bleft$/i,
  /joined using this group's invite link/i,
  /\bchanged (?:the subject|the group|this group's|their phone number|to)\b/i,
  /security code .* changed/i,
  /disappearing messages/i,
  /\bis a contact\.?$/i,
  /\bpinned a message\b/i,
  /business account/i,
];
const GROUP_HINTS =
  /\b(?:created (?:the )?group|added|removed|changed the subject|changed this group's|joined using this group's invite link)\b/i;

interface Entry {
  date: [number, number, number];
  hour: number;
  minute: number;
  second: number;
  meridiem: string | undefined;
  sender: string | null;
  body: string;
  /** iOS prefixes generated lines (media, system notices) with a left-to-right mark. */
  marked: boolean;
}

function matchHeader(line: string): RegExpMatchArray | null {
  return line.match(IOS_HEADER) ?? line.match(ANDROID_HEADER);
}

function normaliseLine(raw: string): string {
  return raw.replace(/[  ]/g, ' ').replace(/^[‎‏]+/, '');
}

export function looksLikeWhatsAppChat(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 20)
    .map(normaliseLine);
  return lines.some((l) => matchHeader(l) !== null);
}

/** "WhatsApp Chat with Alice.txt" / "WhatsApp Chat - Alice.zip" → "Alice" */
export function titleFromFileName(name: string): string | null {
  const base = basename(name)
    .replace(/\.(txt|zip)$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim();
  const match =
    base.match(/^WhatsApp[\s-]+Chat\s+(?:with|-|mit)\s+(.+)$/i) ??
    base.match(/WhatsApp.*?\s(?:com|con|avec|met)\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function splitEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = normaliseLine(raw);
    const header = matchHeader(line);
    if (!header) {
      // A continuation of a multi-line message.
      const last = entries.at(-1);
      if (last) last.body += `\n${raw.replace(BIDI_MARKS, '')}`;
      continue;
    }
    const [, a, b, c, h, mi, s, meridiem, rest = ''] = header;
    const senderMatch = rest.match(SENDER);
    let sender: string | null = null;
    let body = rest;
    if (senderMatch && !/["“”]/.test(senderMatch[1]!)) {
      sender = senderMatch[1]!.replace(BIDI_MARKS, '').trim();
      body = senderMatch[2]!;
    }
    entries.push({
      date: [Number(a), Number(b), Number(c)],
      hour: Number(h),
      minute: Number(mi),
      second: Number(s ?? 0),
      meridiem,
      sender,
      marked: body.startsWith(LRM),
      body: body.replace(BIDI_MARKS, ''),
    });
  }
  return entries;
}

function inferDateOrder(entries: Entry[]): NonNullable<ImportOptions['dateOrder']> {
  if (entries.some((e) => e.date[0] > 31)) return 'YMD';
  const dayFirst = entries.some((e) => e.date[0] > 12);
  const monthFirst = entries.some((e) => e.date[1] > 12);
  if (dayFirst && !monthFirst) return 'DMY';
  if (monthFirst && !dayFirst) return 'MDY';
  // Ambiguous (every day ≤ 12): 12-hour clocks are mostly a US-locale thing.
  return entries.some((e) => e.meridiem) ? 'MDY' : 'DMY';
}

function timestampOf(e: Entry, order: NonNullable<ImportOptions['dateOrder']>): number {
  const [a, b, c] = e.date;
  const [year, month, day] = order === 'YMD' ? [a, b, c] : order === 'MDY' ? [c, a, b] : [c, b, a];
  let hour = e.hour;
  if (e.meridiem) {
    const pm = e.meridiem.toLowerCase() === 'p';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  // Exports carry no time zone; they're in the phone's local time, which we assume is ours.
  return new Date(year < 100 ? 2000 + year : year, month - 1, day, hour, e.minute, e.second).getTime();
}

function attachmentTypeForFile(name: string): AttachmentType {
  const lower = name.toLowerCase();
  if (/-photo-|\.(jpe?g|png|heic|gif)$/.test(lower)) return 'image';
  if (/-video-|\.(mp4|mov|3gp|mkv)$/.test(lower)) return 'video';
  if (/-audio-|\.(opus|ogg|m4a|mp3|aac|wav)$/.test(lower)) return 'audio';
  if (/-sticker-|\.webp$/.test(lower)) return 'sticker';
  if (lower.endsWith('.vcf')) return 'contact';
  return 'document';
}

const OMITTED_TYPES: Record<string, AttachmentType> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  sticker: 'sticker',
  gif: 'video',
  document: 'document',
  'contact card': 'contact',
};

interface Classified {
  kind: ParsedMessage['kind'];
  text: string | null;
  attachments: PendingAttachment[];
  edited: boolean;
  deleted: boolean;
  /** Notices like "Alice added Bob" belong to nobody. */
  anonymous: boolean;
}

function classify(e: Entry): Classified {
  let body = e.body;
  const edited = EDITED_SUFFIX.test(body);
  if (edited) body = body.replace(EDITED_SUFFIX, '');
  const [first = '', ...rest] = body.split('\n');
  const caption = rest.join('\n').trim() || null;
  const result = (
    kind: Classified['kind'],
    text: string | null,
    attachments: PendingAttachment[] = [],
  ): Classified => ({
    kind,
    text,
    attachments,
    edited,
    deleted: false,
    anonymous: false,
  });

  if (e.sender === null) return { ...result('system', body), anonymous: true };
  if (DELETED.test(body.trim())) return { ...result('text', null), deleted: true };
  if (MEDIA_OMITTED.test(first.trim())) return result('media', caption, [{ type: 'other' }]);

  const omitted = first.trim().match(TYPE_OMITTED);
  if (omitted) {
    const attachment: PendingAttachment = { type: OMITTED_TYPES[omitted[2]!.toLowerCase()] ?? 'other' };
    if (omitted[1]) attachment.name = omitted[1];
    return result('media', caption, [attachment]);
  }

  const attached = first.trim().match(IOS_ATTACHED) ?? first.trim().match(ANDROID_ATTACHED);
  if (attached) {
    const file = attached[1]!.trim();
    return result('media', caption, [{ type: attachmentTypeForFile(file), name: file, archivePath: file }]);
  }

  const location = body.trim().match(LOCATION);
  if (location) return result('media', null, [{ type: 'location', url: location[1]! }]);

  if (e.marked && CALL.test(body.trim())) return result('system', body.trim());
  if (e.marked && SYSTEM_PHRASES.some((p) => p.test(body)))
    return { ...result('system', body.trim()), anonymous: true };
  return result('text', body);
}

export function parseWhatsAppChat(
  text: string,
  options: ImportOptions & { fileName: string; baseDir?: string },
): ParsedChat {
  const entries = splitEntries(text);
  if (entries.length === 0) throw new Error(`${options.fileName} doesn't look like a WhatsApp chat export`);
  const order = options.dateOrder ?? inferDateOrder(entries);

  const drafts = entries.map((e) => ({ entry: e, timestamp: timestampOf(e, order), ...classify(e) }));
  const senders = [...new Set(drafts.filter((d) => !d.anonymous).map((d) => d.entry.sender!))];
  const title = titleFromFileName(options.fileName);

  let selfName: string | null = options.selfName?.trim() || null;
  if (!selfName && title && senders.length === 2 && senders.includes(title)) {
    selfName = senders.find((s) => s !== title) ?? null;
  }

  const isGroup = senders.length > 2 || drafts.some((d) => d.kind === 'system' && GROUP_HINTS.test(d.text ?? ''));
  const others = senders.filter((s) => s !== selfName);
  const resolvedTitle = title ?? (others.length ? others.slice(0, 4).join(', ') : 'WhatsApp chat');

  const participants: Participant[] = senders.map((name) => ({ id: name, name, isSelf: name === selfName }));
  const messages: ParsedMessage[] = drafts.map((d) => ({
    senderId: d.anonymous ? 'system' : d.entry.sender!,
    senderName: d.anonymous ? '' : d.entry.sender!,
    fromSelf: !d.anonymous && d.entry.sender === selfName,
    timestamp: d.timestamp,
    kind: d.kind,
    text: d.text,
    attachments: d.attachments,
    edited: d.edited,
    deleted: d.deleted,
  }));
  assignStableIds(messages);

  return {
    platform: 'whatsapp',
    nativeId: slug(resolvedTitle),
    title: resolvedTitle,
    isGroup,
    participants,
    messages,
    baseDir: options.baseDir ?? '',
    selfName,
  };
}
