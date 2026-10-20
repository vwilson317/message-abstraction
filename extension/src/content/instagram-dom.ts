/**
 * Reads the Instagram DM thread on screen from the DOM. Instagram's markup is
 * obfuscated and changes, so this relies only on ARIA roles, `dir="auto"`
 * text leaves, image sources and geometry, never on class names. As of
 * October 2026 (verified against independent open-source readers):
 *
 * - The thread lives at /direct/t/<thread id>/ (numeric so far).
 * - Messages are `div[role="article"]` inside `div[role="group"]` (or
 *   `div[role="row"]`) rows, or `[role="presentation"]` bubbles on accounts
 *   with the other layout.
 * - Nothing marks your own messages; they hug the right edge of their row.
 * - Only about 20 bubbles are rendered at a time (the list is virtualised),
 *   so each read is a window. The server stitches windows together.
 * - Times only appear as centred divider rows ("Today 10:42", "3 Oct 2026").
 */

export interface DomAttachment {
  type: 'image' | 'video' | 'sticker' | 'link' | 'other';
  url?: string;
  name?: string;
}

export interface DomMessage {
  senderName: string;
  fromSelf: boolean;
  text: string | null;
  timestamp?: number;
  attachments: DomAttachment[];
}

export interface DomCapture {
  /** isGroup is left out when the page doesn't make it clear. */
  thread: { id: string; title: string; isGroup?: boolean; participants?: string[] };
  messages: DomMessage[];
  /** The window reaches the newest message, so anything new in it is recent. */
  atBottom: boolean;
}

export interface Diagnosis {
  threadId: string | null;
  container: boolean;
  articles: number;
  presentations: number;
  read: number;
  outgoing: number;
  incoming: number;
  dividers: string[];
  title: string;
}

/** Geometry hook, swappable in tests (happy-dom has no layout engine). */
export type RectOf = (el: Element) => { left: number; right: number; top: number; width: number; height: number };

const defaultRectOf: RectOf = (el) => el.getBoundingClientRect();

export function threadIdFromPath(path: string): string | null {
  const id = path.match(/^\/direct\/t\/([^/?#]+)/)?.[1];
  // Ids the server wouldn't accept are ignored rather than sent.
  return id && /^[\w.-]+$/.test(id) ? id : null;
}

/** A message's row: the full-width line it sits in. */
const ROW = 'div[role="group"], div[role="row"]';

/** Words Instagram's own controls and receipts show. People send some of them as messages too. */
const UI_LABELS =
  /^(seen|seen by .+|seen just now|reply|like|more|delivered|sent|edited|unsend|forward|copy|react|active now|active \d+\s?\w* ago|typing…?)$/i;
const CONTROL = 'button, [role="button"], [aria-label]';
const PLACEHOLDER =
  /unsupported message|to view this message|use the (instagram |mobile )?app|only be (replayed|played|viewed) once/i;
const ROUTES = new Set([
  'direct',
  'explore',
  'reels',
  'stories',
  'p',
  'reel',
  'accounts',
  'about',
  'legal',
  'privacy',
  'terms',
]);

function isScrollable(el: Element, view: Window): boolean {
  const style = view.getComputedStyle(el);
  return /(auto|scroll)/.test(style.overflowY);
}

/** The thread's scroll container: the deepest scrollable element holding message bubbles. */
export function findScrollContainer(doc: Document): HTMLElement | null {
  const view = doc.defaultView!;
  const root = doc.querySelector('div[role="main"]') ?? doc.body;
  const candidates = [...root.querySelectorAll<HTMLElement>('div')].filter(
    (div) => isScrollable(div, view) && div.querySelector('[role="article"], [role="presentation"]'),
  );
  // Deepest wins: a candidate with no other candidate inside it.
  return candidates.filter((c) => !candidates.some((other) => other !== c && c.contains(other))).at(-1) ?? null;
}

/**
 * The bubble's text. A label word inside a control is always UI. Otherwise
 * it's a receipt ("Seen") when the bubble has other content, and the message
 * itself when it doesn't: a friend can reply just "Like". Receipts follow the
 * bubble, so the first label then is the message.
 */
function leafTexts(unit: Element, hasAttachments: boolean): string[] {
  const leaves = [...unit.querySelectorAll('[dir="auto"]')].filter(
    (el) => !el.querySelector('[dir="auto"]') && !el.closest('time'),
  );
  const texts: string[] = [];
  const labels: string[] = [];
  for (const el of leaves) {
    const text = (el.textContent ?? '').replace(/\s+\n/g, '\n').trim();
    if (!text || texts.includes(text)) continue;
    const control = el.closest(CONTROL);
    if (!UI_LABELS.test(text)) texts.push(text);
    else if (!control || control === unit || !unit.contains(control)) labels.push(text);
  }
  return texts.length || hasAttachments ? texts : labels.slice(0, 1);
}

function attachmentsOf(unit: Element, rectOf: RectOf): DomAttachment[] {
  const attachments: DomAttachment[] = [];
  const imgs = [...unit.querySelectorAll('img')];
  const hasPlayOverlay = imgs.some((img) => /playButton/i.test(img.src));
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? '';
    const alt = img.getAttribute('alt') ?? '';
    if (/playButton/i.test(src) || /\/images\/instagram\//.test(src) || /profile picture/i.test(alt)) continue;
    if (img.closest('a[href*="/p/"], a[href*="/reel/"]')) continue; // a shared post's thumbnail
    if (alt === 'Sticker' || src.includes('/emg1/')) {
      attachments.push({ type: 'sticker' });
      continue;
    }
    const rect = rectOf(img);
    const width = rect.width || Number(img.getAttribute('width') ?? 0);
    const height = rect.height || Number(img.getAttribute('height') ?? 0);
    if (width < 60 || height < 60) continue; // avatars, emoji, icons
    attachments.push({ type: hasPlayOverlay ? 'video' : 'image', ...(/^https:\/\//.test(src) && { url: src }) });
  }
  for (const a of unit.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"], a[href*="/reel/"]')) {
    const href = a.getAttribute('href') ?? '';
    const url = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
    if (!attachments.some((x) => x.url === url)) attachments.push({ type: 'link', url, name: 'Shared post' });
  }
  return attachments;
}

/**
 * Own messages sit against the right edge of their row. Without layout
 * (tests, odd states) fall back to flex alignment on the way up.
 */
function isOutgoing(unit: Element, container: Element, rectOf: RectOf, view: Window): boolean {
  const row = unit.closest(ROW) ?? container;
  const r = rectOf(unit);
  const rr = rectOf(row);
  if (rr.width > 0 && r.width > 0) return Math.abs(r.right - rr.right) < Math.abs(r.left - rr.left);
  for (let el: Element | null = unit; el && el !== container; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    if (style.justifyContent === 'flex-end' || style.alignSelf === 'flex-end' || style.marginLeft === 'auto')
      return true;
  }
  return false;
}

const MONTH_NAMES = [
  'jan(?:uary)?',
  'feb(?:ruary)?',
  'mar(?:ch)?',
  'apr(?:il)?',
  'may',
  'june?',
  'july?',
  'aug(?:ust)?',
  'sep(?:t(?:ember)?)?',
  'oct(?:ober)?',
  'nov(?:ember)?',
  'dec(?:ember)?',
];
const WEEKDAY_NAMES = [
  'sun(?:day)?',
  'mon(?:day)?',
  'tue(?:s(?:day)?)?',
  'wed(?:nesday)?',
  'thu(?:r(?:s(?:day)?)?)?',
  'fri(?:day)?',
  'sat(?:urday)?',
];
const MONTH = `(?:${MONTH_NAMES.join('|')})\\.?`;
const WEEKDAY = `(?:${WEEKDAY_NAMES.join('|')})\\.?`;
const CLOCK = String.raw`\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?`;
const DAY = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
const YEAR = String.raw`(?:,?\s+\d{4})?`;
/** An optional time after a date: "…, 9:15 AM", "… at 10:42". */
const AT_TIME = String.raw`(?:,?\s*(?:at\s+)?${CLOCK})?`;

/** A whole label that is a date and/or time, and nothing else, so message text never passes. */
const DIVIDER_PATTERN = new RegExp(
  [
    String.raw`(?:today|yesterday)${AT_TIME}`,
    String.raw`${WEEKDAY}${AT_TIME}`,
    String.raw`(?:${WEEKDAY},?\s+)?${MONTH}\s+${DAY}${YEAR}${AT_TIME}`,
    String.raw`(?:${WEEKDAY},?\s+)?${DAY}\s+${MONTH}${YEAR}${AT_TIME}`,
    CLOCK,
  ]
    .map((alt) => `^${alt}$`)
    .join('|'),
  'i',
);

export function isDividerLabel(text: string): boolean {
  return DIVIDER_PATTERN.test(text.trim().replace(/\s+/g, ' '));
}

const CLOCK_RE = /(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i;

function clock(text: string): [number, number] | null {
  const m = text.match(CLOCK_RE);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3]?.[0]?.toLowerCase();
  if (meridiem === 'p' && hour < 12) hour += 12;
  if (meridiem === 'a' && hour === 12) hour = 0;
  return hour < 24 && minute < 60 ? [hour, minute] : null;
}

/** Labels can't be in the future; allow a little clock skew. */
const FUTURE_SLACK_MS = 5 * 60 * 1000;

/**
 * Turn an Instagram divider label into a time. English labels only; others
 * return null and the server fills in times from order. Never returns a time
 * in the future: a year-less date that would be moves back a year (a
 * December label read in January), and a "Today" or bare time moves back a
 * day (a tab left open past midnight).
 */
export function parseDividerTime(label: string, now: Date = new Date()): number | null {
  const text = label.trim().toLowerCase().replace(/\s+/g, ' ');
  const time = clock(text) ?? [0, 0];
  const at = (y: number, m: number, d: number) => new Date(y, m, d, time[0], time[1]).getTime();
  const day = (offset: number) => at(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const limit = now.getTime() + FUTURE_SLACK_MS;
  const past = (ts: number, earlier: () => number) => (ts > limit ? earlier() : ts);
  const checked = (ts: number | null) => (ts !== null && ts <= limit ? ts : null);

  if (/^today\b/.test(text)) return checked(past(day(0), () => day(-1)));
  if (/^yesterday\b/.test(text)) return checked(day(-1));
  if (new RegExp(`^${CLOCK}$`, 'i').test(text)) return checked(past(day(0), () => day(-1)));

  // Take the clock out first, so its hour is never read as the day of the month.
  const date = text.replace(CLOCK_RE, ' ');
  const monthMatch = new RegExp(`\\b(${MONTH_NAMES.join('|')})\\.?(?![a-z])`).exec(date);
  const weekday = WEEKDAY_NAMES.findIndex((w) => new RegExp(`^${w}\\.?(?![a-z])`).test(date));
  if (!monthMatch && weekday >= 0) {
    // Weekday labels cover the past week; today and yesterday have their own words.
    const back = (now.getDay() - weekday + 7) % 7 || 7;
    return checked(day(-back));
  }
  if (!monthMatch) return null;
  const month = MONTH_NAMES.findIndex((m) => new RegExp(`^${m}$`).test(monthMatch[1]!));
  // The day sits next to the month: "Oct 3" or "3 Oct".
  const after = date.slice(monthMatch.index + monthMatch[0].length).match(/^\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
  const before = date.slice(0, monthMatch.index).match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*$/);
  const dayOfMonth = Number(after?.[1] ?? before?.[1] ?? 0);
  if (dayOfMonth < 1 || dayOfMonth > 31) return null;
  const year = date.match(/\b(\d{4})\b/);
  if (year) return checked(at(Number(year[1]), month, dayOfMonth));
  const y = now.getFullYear();
  return checked(past(at(y, month, dayOfMonth), () => at(y - 1, month, dayOfMonth)));
}

/** Your own username, which Instagram embeds in page JSON. */
function ownHandle(doc: Document): string | null {
  for (const script of doc.querySelectorAll('script')) {
    const m = script.textContent?.match(/"username"\s*:\s*"([A-Za-z0-9._]{1,30})"/);
    if (m) return m[1]!;
  }
  return null;
}

function handleOf(a: Element, exclude: string | null): string | null {
  const m = (a.getAttribute('href') ?? '').match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
  return m && !ROUTES.has(m[1]!) && m[1] !== exclude ? m[1]! : null;
}

function handlesIn(root: Element, exclude: string | null): string[] {
  return [...root.querySelectorAll('a[href]')].map((a) => handleOf(a, exclude)).filter((h): h is string => !!h);
}

function avatarName(img: Element): string | null {
  return (img.getAttribute('alt') ?? '').match(/^(.+?)['’]s profile picture$/i)?.[1] ?? null;
}

/** A shared post or reel: its card shows the author's avatar and links, which say nothing about the thread. */
const SHARED = 'a[href*="/p/"], a[href*="/reel/"]';

/**
 * The thread's own header: what sits before the message list in the thread
 * pane. Climbs from the list, collecting earlier siblings, but never the
 * inbox column (it links to other threads) and, with layout, only what's
 * above the list.
 */
function headerOf(container: Element, main: Element, rectOf: RectOf): Element[] {
  const list = rectOf(container);
  const header: Element[] = [];
  for (let node: Element = container; node !== main && node.parentElement; node = node.parentElement) {
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.querySelector('a[href*="/direct/t/"]')) continue;
      const r = rectOf(sib);
      if (list.width > 0 && r.width > 0 && (r.right <= list.left || r.left >= list.right)) continue;
      header.push(sib);
    }
  }
  return header;
}

/**
 * Whether the page says this is a group. True on a member count or several
 * people in the header, or several people writing in the window; false when
 * the header (or the profile card at the top) names exactly one person;
 * undefined when nothing on screen tells.
 */
function groupSignal(
  header: Element[],
  container: Element,
  own: string | null,
  speakers: Set<string>,
): boolean | undefined {
  const texts = header.flatMap((el) => [el, ...el.querySelectorAll('*')]).filter((el) => el.children.length === 0);
  if (texts.some((el) => /\b\d+\s+(members|people|participants)\b/i.test(el.textContent ?? ''))) return true;
  const avatars = new Set(
    header.flatMap((el) => [...el.querySelectorAll('img[alt]')].map(avatarName)).filter((n) => n && n !== own),
  );
  if (avatars.size > 1 || speakers.size > 1) return true;
  const handles = new Set(header.flatMap((el) => handlesIn(el, own)));
  const cards = new Set(
    [...container.querySelectorAll('a[href]')]
      .filter((a) => a.querySelector('[role="article"], [role="presentation"]'))
      .map((a) => handleOf(a, own))
      .filter(Boolean),
  );
  if (handles.size === 1 || (handles.size === 0 && cards.size === 1)) return false;
  return undefined;
}

function threadTitle(doc: Document, container: Element, own: string | null): string {
  const main = doc.querySelector('div[role="main"]') ?? doc.body;
  // The header sits above the scroll container; prefer its explicit title text.
  for (const el of main.querySelectorAll('span[title], h1, h2')) {
    if (container.contains(el)) continue;
    const text = (el.getAttribute('title') || el.textContent || '').trim();
    if (text && text.length <= 100 && !UI_LABELS.test(text)) return text;
  }
  // 1:1 threads: the other person's profile link is the most frequent one on the page.
  const counts = new Map<string, number>();
  for (const h of handlesIn(main, own)) counts.set(h, (counts.get(h) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Instagram';
}

/**
 * In groups, a run of messages shows the sender's avatar or profile link once,
 * beside the bubble. Only that slot counts: avatars and links inside a
 * message (a shared post's author, an @mention) or another bubble don't.
 */
function senderHint(unit: Element, own: string | null, units: Element[]): string | null {
  const row = unit.closest(ROW) ?? unit.parentElement;
  if (!row) return null;
  const beside = (el: Element) =>
    !units.some((u) => u.contains(el)) && !el.closest(SHARED) && !el.closest('[dir="auto"]');
  for (const img of row.querySelectorAll('img[alt]')) {
    const name = avatarName(img);
    if (name && name !== own && beside(img)) return name;
  }
  for (const a of row.querySelectorAll('a[href]')) {
    const handle = beside(a) ? handleOf(a, own) : null;
    if (handle) return handle;
  }
  return null;
}

/** Scrolled all the way to the newest message (Instagram's list is usually column-reverse). */
function atNewest(container: HTMLElement, view: Window): boolean {
  const SLACK_PX = 4;
  if (container.scrollTop < -SLACK_PX) return false; // only a reversed list scrolls negative
  const reversed = [container, container.firstElementChild].some(
    (el) => el && view.getComputedStyle(el).flexDirection === 'column-reverse',
  );
  if (reversed) return Math.abs(container.scrollTop) <= SLACK_PX;
  return container.scrollHeight - container.clientHeight - container.scrollTop <= SLACK_PX;
}

function collect(doc: Document, rectOf: RectOf) {
  const view = doc.defaultView!;
  const container = findScrollContainer(doc);
  if (!container) return null;
  let units = [...container.querySelectorAll('div[role="article"]')];
  const layout = units.length ? 'article' : 'presentation';
  if (!units.length) {
    units = [...container.querySelectorAll('[role="presentation"]')].filter(
      (el) => !el.querySelector('[role="presentation"]') && el.querySelector('[dir="auto"], img') !== null,
    );
  }
  // Skip the other person's profile card at the top of the thread.
  units = units.filter((u) => !u.closest('a[href^="/"]'));

  const dividers = [...container.querySelectorAll('[dir="auto"], span, div')].filter((el) => {
    if (el.children.length > 0 || units.some((u) => u.contains(el))) return false;
    return isDividerLabel(el.textContent ?? '');
  });

  const tops = new Map<Element, number>();
  const topOf = (el: Element) => {
    let t = tops.get(el);
    if (t === undefined) {
      t = rectOf(el).top;
      tops.set(el, t);
    }
    return t;
  };
  const items = [
    ...units.map((el) => ({ kind: 'unit' as const, el })),
    ...dividers.map((el) => ({ kind: 'divider' as const, el })),
  ];
  const hasLayout = items.some((i) => topOf(i.el) !== 0);
  items.sort((a, b) => {
    if (hasLayout && topOf(a.el) !== topOf(b.el)) return topOf(a.el) - topOf(b.el);
    // Document order, for when there's no layout to go on.
    return a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1;
  });
  return { container, items, layout, view };
}

/** Read the thread on screen, oldest first. Returns null when no thread is showing. */
export function readInstagramThread(
  doc: Document,
  threadId: string,
  rectOf: RectOf = defaultRectOf,
  now = new Date(),
): DomCapture | null {
  const found = collect(doc, rectOf);
  if (!found) return null;
  const { container, items, view } = found;
  const own = ownHandle(doc);
  const title = threadTitle(doc, container, own);
  const main = doc.querySelector('div[role="main"]') ?? doc.body;

  // Avatars and profile links beside bubbles name senders in groups.
  const units = items.filter((i) => i.kind === 'unit').map((i) => i.el);
  const hints = new Map(units.map((unit) => [unit, senderHint(unit, own, units)]));
  const speakers = new Set([...hints.values()].filter((h): h is string => !!h));
  const isGroup = groupSignal(headerOf(container, main, rectOf), container, own, speakers);

  const messages: DomMessage[] = [];
  let currentTime: number | undefined;
  let lastSender: string | null = null;
  for (const item of items) {
    if (item.kind === 'divider') {
      currentTime = parseDividerTime(item.el.textContent ?? '', now) ?? currentTime;
      continue;
    }
    const unit = item.el;
    const attachments = attachmentsOf(unit, rectOf);
    const texts = leafTexts(unit, attachments.length > 0);
    const placeholder = texts.some((t) => PLACEHOLDER.test(t));
    if (!texts.length && !attachments.length) continue;
    const fromSelf = isOutgoing(unit, container, rectOf, view);
    let senderName = '';
    if (!fromSelf) {
      // In a 1:1 thread the other person is the thread. Otherwise a run shows its sender
      // once; unknown stays empty so the server keeps any name it learned before.
      senderName = isGroup === false ? title : (hints.get(unit) ?? lastSender ?? '');
      lastSender = senderName || lastSender;
    } else lastSender = null;
    messages.push({
      senderName,
      fromSelf,
      text: placeholder ? null : texts.join('\n') || null,
      ...(currentTime !== undefined && { timestamp: currentTime }),
      attachments: placeholder ? [{ type: 'other', name: 'Not viewable on the web' }] : attachments,
    });
  }
  return {
    thread: {
      id: threadId,
      title,
      ...(isGroup !== undefined && { isGroup }),
      ...(isGroup && { participants: [...speakers] }),
    },
    messages,
    atBottom: atNewest(container, view),
  };
}

/** Counts that show at a glance whether the reader still understands Instagram's markup. */
export function diagnose(
  doc: Document,
  rectOf: RectOf = defaultRectOf,
  threadId = threadIdFromPath(doc.location?.pathname ?? ''),
): Diagnosis {
  const container = findScrollContainer(doc);
  const capture = threadId ? readInstagramThread(doc, threadId, rectOf) : null;
  const found = collect(doc, rectOf);
  return {
    threadId,
    container: !!container,
    articles: container?.querySelectorAll('div[role="article"]').length ?? 0,
    presentations: container?.querySelectorAll('[role="presentation"]').length ?? 0,
    read: capture?.messages.length ?? 0,
    outgoing: capture?.messages.filter((m) => m.fromSelf).length ?? 0,
    incoming: capture?.messages.filter((m) => !m.fromSelf).length ?? 0,
    dividers: found?.items.filter((i) => i.kind === 'divider').map((i) => (i.el.textContent ?? '').trim()) ?? [],
    title: capture?.thread.title ?? '',
  };
}
