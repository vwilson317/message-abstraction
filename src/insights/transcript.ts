import type { Conversation, Message } from '../core/types';

export interface TranscriptOptions {
  /** Only messages at or after this time (ms). */
  from?: number;
  /** Only messages at or before this time (ms). */
  to?: number;
  /** Only the most recent N messages (applied after from/to). */
  last?: number;
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function body(m: Message): string {
  if (m.deleted) return '[deleted]';
  const parts = m.attachments.map((a) => `[${a.type}${a.name ? `: ${a.name}` : ''}]`);
  if (m.text) parts.push(m.text);
  let line = parts.join(' ') || '[empty]';
  if (m.edited) line += ' [edited]';
  if (m.reactions.length) line += ` {${m.reactions.map((r) => `${r.emoji} ${r.senderName}`).join(', ')}}`;
  return line;
}

/**
 * A plain-text transcript in the shape people already paste into an LLM.
 * This is the context format the assistant layer will use.
 */
export function formatTranscript(
  conversation: Conversation,
  messages: Message[],
  options: TranscriptOptions = {},
): string {
  let selected = messages.filter(
    (m) =>
      (options.from === undefined || m.timestamp >= options.from) &&
      (options.to === undefined || m.timestamp <= options.to),
  );
  if (options.last !== undefined) selected = selected.slice(-options.last);

  const people = conversation.participants.map((p) => (p.isSelf ? `${p.name} (me)` : p.name)).join(', ');
  const header = [
    `# ${conversation.title}`,
    `# ${conversation.platform === 'whatsapp' ? 'WhatsApp' : 'Instagram'} ${conversation.isGroup ? 'group' : 'direct'} conversation`,
    people && `# Participants: ${people}`,
    selected.length
      ? `# ${selected.length} messages, ${stamp(selected[0]!.timestamp)} to ${stamp(selected.at(-1)!.timestamp)}`
      : '# No messages in range',
  ].filter(Boolean);

  const lines = selected.map((m) =>
    m.kind === 'system'
      ? `[${stamp(m.timestamp)}] — ${m.text ?? ''}`
      : `[${stamp(m.timestamp)}] ${m.senderName}: ${body(m)}`,
  );
  return `${header.join('\n')}\n\n${lines.join('\n')}\n`;
}
