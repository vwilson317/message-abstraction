/** Hand-written exports that mirror the real formats, quirks included. */

export const ANDROID_CHAT = [
  '12/03/2024, 09:15 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.',
  '12/03/2024, 09:15 - Alice: Morning! Are we still on for Saturday?',
  '12/03/2024, 09:15 - Alice: Also, I found the place',
  'it has a terrace',
  'and a view',
  '12/03/2024, 09:47 - Vince: Yes! Send me the link',
  '12/03/2024, 09:48 - Alice: <Media omitted>',
  '13/03/2024, 22:01 - Vince: This message was deleted',
  '13/03/2024, 22:05 - Alice: See you then 😊 <This message was edited>',
  '14/03/2024, 07:30 - Alice: IMG-20240314-WA0001.jpg (file attached)',
  'the terrace!',
  '14/03/2024, 07:31 - Alice: location: https://maps.google.com/?q=38.72,-9.14',
].join('\n');

const LRM = '‎';
const NNBSP = ' ';

export const IOS_CHAT = [
  `[3/15/24, 9:04:13${NNBSP}PM] Trip Crew: ${LRM}Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.`,
  `[3/15/24, 9:04:13${NNBSP}PM] Trip Crew: ${LRM}Alice created group “Trip Crew”`,
  `[3/15/24, 9:05:00${NNBSP}PM] Alice: Who's booking flights?`,
  `[3/15/24, 9:06:30${NNBSP}PM] Bob: me`,
  `${LRM}[3/15/24, 9:07:02${NNBSP}PM] Bob: ${LRM}image omitted`,
  `${LRM}[3/15/24, 9:08:45${NNBSP}PM] Vince: ${LRM}<attached: 00000012-PHOTO-2024-03-15-21-08-45.jpg>`,
  `[3/16/24, 12:00:01${NNBSP}AM] Vince: midnight message`,
  `[3/16/24, 12:30:00${NNBSP}PM] Alice: ${LRM}Missed voice call`,
].join('\n');

export function igThread(opts: {
  title: string;
  others: string[];
  self: string;
  path: string;
  messages: object[];
}): string {
  return JSON.stringify({
    participants: [...opts.others, opts.self].map((name) => ({ name })),
    messages: opts.messages,
    title: opts.title,
    is_still_participant: true,
    thread_path: opts.path,
  });
}

/** Encode a string the way Meta's exports do: each UTF-8 byte as its own \u00XX char. */
export function mojibake(value: string): string {
  return Array.from(new TextEncoder().encode(value), (b) => String.fromCharCode(b)).join('');
}
