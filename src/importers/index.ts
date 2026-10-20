import { basename, dirname } from 'node:path/posix';
import type { Hub } from '../core/hub';
import { mimeForFile } from '../core/media';
import type { Attachment, Platform } from '../core/types';
import { readText, type Archive } from './archive';
import {
  findInstagramThreads,
  inferSelfFromThreads,
  looksLikeInstagramThread,
  parseInstagramThread,
  profileNameFromExport,
  readThreadParticipants,
} from './instagram';
import type { ImportOptions, ParsedChat } from './types';
import { looksLikeWhatsAppChat, parseWhatsAppChat } from './whatsapp';

export type { ImportOptions } from './types';

/** Media larger than this is skipped (the message still shows that there was an attachment). */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MEDIA_BATCH = 200;

export interface ImportSummary {
  conversations: {
    id: string;
    title: string;
    platform: Platform;
    messageCount: number;
    selfName: string | null;
  }[];
  warnings: string[];
}

export function parseArchive(archive: Archive, options: ImportOptions): ParsedChat[] {
  const igThreads = findInstagramThreads(archive.paths);
  if (igThreads.size > 0) return parseInstagramExport(archive, igThreads, options);

  const jsonFiles = archive.paths.filter((p) => p.toLowerCase().endsWith('.json'));
  if (jsonFiles.length === 1 && archive.paths.length === 1) {
    const text = readText(archive, jsonFiles[0]!);
    if (looksLikeInstagramThread(text)) {
      return [parseInstagramThread([text], { ...options, threadDir: basename(jsonFiles[0]!, '.json') })];
    }
  }

  const chats: ParsedChat[] = [];
  for (const path of archive.paths.filter((p) => p.toLowerCase().endsWith('.txt'))) {
    const text = readText(archive, path);
    if (!looksLikeWhatsAppChat(text)) continue;
    // iOS names every export "_chat.txt"; the chat's name is on the zip or folder instead.
    const parent = dirname(path);
    const fileName =
      basename(path) === '_chat.txt' ? (parent !== '.' ? basename(parent) : archive.name) : basename(path);
    chats.push(parseWhatsAppChat(text, { ...options, fileName, baseDir: parent === '.' ? '' : parent }));
  }
  if (chats.length === 0) {
    throw new Error(
      `Couldn't find a WhatsApp chat export (.txt) or Instagram messages (message_1.json) in ${archive.name}`,
    );
  }
  return chats;
}

function parseInstagramExport(archive: Archive, threads: Map<string, string[]>, options: ImportOptions): ParsedChat[] {
  const texts = new Map<string, string[]>();
  for (const [dir, files] of threads)
    texts.set(
      dir,
      files.map((f) => readText(archive, f)),
    );

  let selfName = options.selfName?.trim() || null;
  if (!selfName) {
    const profile = archive.paths.find((p) => p.endsWith('personal_information.json'));
    if (profile) selfName = profileNameFromExport(readText(archive, profile));
  }
  if (!selfName) {
    selfName = inferSelfFromThreads([...texts.values()].map((files) => readThreadParticipants(files[0]!)));
  }

  return [...texts].map(([dir, files]) => {
    // Media URIs are relative to the export root, which may sit inside a wrapper folder.
    const exportRoot =
      dir.match(/^(.*?)(?:your_instagram_activity\/)?messages\/[^/]+\/[^/]+$/)?.[1]?.replace(/\/$/, '') ?? '';
    return parseInstagramThread(files, { ...options, ...(selfName && { selfName }), threadDir: dir, exportRoot });
  });
}

/** Copy referenced media out of the archive and swap archive paths for served URLs. */
function resolveMedia(hub: Hub, archive: Archive, chat: ParsedChat): number {
  const available = new Set(archive.paths);
  const wanted = new Map<string, Attachment[]>();
  let missing = 0;
  for (const message of chat.messages) {
    for (const attachment of message.attachments) {
      if (!attachment.archivePath) continue;
      const path = chat.baseDir ? `${chat.baseDir}/${attachment.archivePath}` : attachment.archivePath;
      delete attachment.archivePath;
      attachment.mimeType ??= mimeForFile(path);
      if (!available.has(path)) {
        missing++;
        continue;
      }
      if (archive.size(path) > MAX_MEDIA_BYTES) continue;
      wanted.set(path, [...(wanted.get(path) ?? []), attachment]);
    }
  }
  const paths = [...wanted.keys()];
  for (let i = 0; i < paths.length; i += MEDIA_BATCH) {
    for (const [path, data] of archive.readMany(paths.slice(i, i + MEDIA_BATCH))) {
      const url = hub.media.save(data, { fileName: path });
      for (const attachment of wanted.get(path) ?? []) attachment.url = url;
    }
  }
  return missing;
}

export function importArchive(hub: Hub, archive: Archive, options: ImportOptions = {}): ImportSummary {
  const chats = parseArchive(archive, options);
  const summary: ImportSummary = { conversations: [], warnings: [] };

  for (const chat of chats) {
    const missing = resolveMedia(hub, archive, chat);
    const sourceId = `import:${chat.platform}`;
    const conversation = hub.upsertConversation(sourceId, 'import', {
      platform: chat.platform,
      nativeId: chat.nativeId,
      title: chat.title,
      isGroup: chat.isGroup,
      participants: chat.participants,
    });
    hub.upsertMessages(
      sourceId,
      'import',
      chat.messages.map((m) => ({ ...m, nativeId: m.nativeId!, conversationNativeId: chat.nativeId })),
      { countUnread: false },
    );

    let selfName = chat.selfName;
    if (selfName && chat.participants.some((p) => p.id === selfName)) {
      hub.setSelf(conversation.id, selfName);
    } else {
      if (selfName) summary.warnings.push(`"${selfName}" doesn't appear in "${chat.title}".`);
      selfName = null;
      if (chat.participants.length > 0) {
        summary.warnings.push(
          `Couldn't tell which participant is you in "${chat.title}". Pick yourself in the insights panel.`,
        );
      }
    }
    if (missing > 0) {
      summary.warnings.push(`${missing} attachment(s) in "${chat.title}" weren't included in the export.`);
    }
    const stored = hub.requireConversation(conversation.id);
    summary.conversations.push({
      id: stored.id,
      title: stored.title,
      platform: stored.platform,
      messageCount: stored.messageCount,
      selfName,
    });
  }
  return summary;
}
