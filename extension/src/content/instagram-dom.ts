/**
 * Reads the Instagram DM thread on screen from the DOM. Instagram's markup is
 * obfuscated and changes, so this relies only on ARIA roles, `dir="auto"`
 * text leaves, image sources and geometry, never on class names. As of
 * October 2026 (verified against independent open-source readers):
 *
 * - The thread lives at /direct/t/<thread_fbid>/.
 * - Messages are `div[role="article"]` inside `div[role="group"]` rows, or
 *   `[role="presentation"]` bubbles on accounts with the other layout.
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
  thread: { id: string; title: string; isGroup: boolean; participants?: string[] };
  messages: DomMessage[];
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
  return path.match(/^\/direct\/t\/(\d+)/)?.[1] ?? null;
}

const UI_LABELS =
  /^(seen|seen by .+|seen just now|reply|like|more|delivered|sent|edited|unsend|forward|copy|react|active now|active \d+\s?\w* ago|typing…?)$/i;
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

function leafTexts(unit: Element): string[] {
  const leaves = [...unit.querySelectorAll('[dir="auto"]')].filter(
    (el) => !el.querySelector('[dir="auto"]') && !el.closest('time'),
  );
  const texts: string[] = [];
  for (const el of leaves) {
    const text = (el.textContent ?? '').replace(/\s+\n/g, '\n').trim();
    if (!text || UI_LABELS.test(text) || texts.includes(text)) continue;
    texts.push(text);
  }
  return texts;
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
  const row = unit.closest('div[role="group"]') ?? container;
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

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function clock(text: string): [number, number] | null {
  const m = text.match(/(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3]?.[0]?.toLowerCase();
  if (meridiem === 'p' && hour < 12) hour += 12;
  if (meridiem === 'a' && hour === 12) hour = 0;
  return hour < 24 && minute < 60 ? [hour, minute] : null;
}

/**
 * Turn an Instagram divider label into a time. English labels only; others
 * return null and the server fills in times from order.
 */
export function parseDividerTime(label: string, now: Date = new Date()): number | null {
  const text = label.trim().toLowerCase();
  const time = clock(text) ?? [0, 0];
  const at = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), time[0], time[1]).getTime();
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);

  if (/^today\b/.test(text)) return at(day(0));
  if (/^yesterday\b/.test(text)) return at(day(-1));

  const weekday = WEEKDAYS.findIndex((w) => text.startsWith(w));
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}[a-z]*\\b`).test(text));
  if (weekday >= 0 && month < 0) {
    // Weekday labels cover the past week; today and yesterday have their own words.
    const back = (now.getDay() - weekday + 7) % 7 || 7;
    return at(day(-back));
  }
  if (month >= 0) {
    const nums = [...text.matchAll(/\b(\d{1,4})\b/g)].map((m) => Number(m[1]));
    const year = nums.find((n) => n >= 2000) ?? now.getFullYear();
    const dayOfMonth = nums.find((n) => n >= 1 && n <= 31 && !(clock(text) && text.includes(`${n}:`)));
    if (!dayOfMonth) return null;
    return at(new Date(year, month, dayOfMonth));
  }
  if (/^\d{1,2}[:.]\d{2}/.test(text)) return at(day(0));
  return null;
}

const DIVIDER_PATTERN =
  /^(today|yesterday|mon|tue|wed|thu|fri|sat|sun)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b.*\d|^\d{1,2}[:.]\d{2}(\s*[ap]\.?m\.?)?$/i;

/** Your own username, which Instagram embeds in page JSON. */
function ownHandle(doc: Document): string | null {
  for (const script of doc.querySelectorAll('script')) {
    const m = script.textContent?.match(/"username"\s*:\s*"([A-Za-z0-9._]{1,30})"/);
    if (m) return m[1]!;
  }
  return null;
}

function handlesIn(root: Element, exclude: string | null): string[] {
  const handles: string[] = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const m = (a.getAttribute('href') ?? '').match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    if (m && !ROUTES.has(m[1]!) && m[1] !== exclude) handles.push(m[1]!);
  }
  return handles;
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

/** In groups, a run of messages shows the sender's avatar or profile link once. */
function senderHint(unit: Element, own: string | null): string | null {
  const row = unit.closest('div[role="group"]') ?? unit.parentElement;
  if (!row) return null;
  for (const img of row.querySelectorAll('img[alt]')) {
    const m = (img.getAttribute('alt') ?? '').match(/^(.+?)['’]s profile picture$/i);
    if (m && m[1] !== own) return m[1]!;
  }
  return handlesIn(row, own)[0] ?? null;
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
    return DIVIDER_PATTERN.test((el.textContent ?? '').trim());
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

  // Avatars and profile links name senders in groups; one distinct name means a 1:1 thread.
  const hints = new Map<Element, string | null>();
  for (const item of items) if (item.kind === 'unit') hints.set(item.el, senderHint(item.el, own));
  const distinct = new Set([...hints.values()].filter((h): h is string => !!h));
  const isGroup = distinct.size > 1;

  const messages: DomMessage[] = [];
  let currentTime: number | undefined;
  let lastSender: string | null = null;
  for (const item of items) {
    if (item.kind === 'divider') {
      currentTime = parseDividerTime(item.el.textContent ?? '', now) ?? currentTime;
      continue;
    }
    const unit = item.el;
    const texts = leafTexts(unit);
    const attachments = attachmentsOf(unit, rectOf);
    const placeholder = texts.some((t) => PLACEHOLDER.test(t));
    if (!texts.length && !attachments.length) continue;
    const fromSelf = isOutgoing(unit, container, rectOf, view);
    let senderName = '';
    if (!fromSelf) {
      // In a 1:1 thread the other person is the thread. In groups, a run shows its
      // sender once; unknown stays empty so the server keeps any name it learned before.
      senderName = isGroup ? (hints.get(unit) ?? lastSender ?? '') : title;
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
    thread: { id: threadId, title, isGroup, ...(isGroup && { participants: [...distinct] }) },
    messages,
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
