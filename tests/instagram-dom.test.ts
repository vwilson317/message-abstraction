// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  diagnose,
  findScrollContainer,
  isDividerLabel,
  parseDividerTime,
  readInstagramThread,
  threadIdFromPath,
  type RectOf,
} from '../extension/src/content/instagram-dom';

/**
 * A thread page shaped like instagram.com/direct/t/<id>/ in October 2026:
 * ARIA roles and dir="auto" text, obfuscated classes (irrelevant here), a
 * column-reverse scroll container, centred date dividers.
 */
const THREAD = `
<div role="main">
  <div class="x1abc"><span title="Maya Lopez">Maya Lopez</span></div>
  <div class="x9scroll" style="overflow-y: scroll; display: flex; flex-direction: column-reverse;">
    <div>
      <a href="/maya.lopez/"><div role="article"><span dir="auto">Maya Lopez</span><span dir="auto">Instagram</span></div></a>
      <div><span dir="auto">Oct 3, 2026, 9:15 AM</span></div>
      <div role="group" data-rect="0,600">
        <div role="article" data-rect="10,200"><div><span dir="auto">hey!</span></div></div>
        <img alt="maya.lopez's profile picture" src="https://scontent.cdninstagram.com/avatar.jpg" width="28" height="28">
      </div>
      <div role="group" data-rect="0,600">
        <div role="article" data-rect="400,590"><div><span dir="auto">hi :)</span></div><span dir="auto">Seen</span></div>
      </div>
      <div><span dir="auto">Today 10:42</span></div>
      <div role="group">
        <div role="article"><img src="https://scontent.cdninstagram.com/photo.jpg" width="240" height="320"></div>
      </div>
      <div role="group">
        <div role="article"><span dir="auto">This message can only be viewed once. Use the Instagram app to view it.</span></div>
      </div>
      <div role="group" style="display: flex; justify-content: flex-end;">
        <div role="article"><img alt="Sticker" src="https://www.instagram.com/emg1/sticker.png" width="120" height="120"></div>
      </div>
      <div role="group">
        <div role="article"><a href="/p/C0ffee/"><img src="https://scontent.cdninstagram.com/thumb.jpg" width="150" height="150"></a><span dir="auto">look at this</span></div>
      </div>
    </div>
  </div>
</div>
<script type="application/json">{"viewer":{"username":"vince.w"}}</script>
`;

/** happy-dom has no layout, so geometry comes from data-rect="left,right" where a test needs it. */
const rectOf: RectOf = (el) => {
  const [left = 0, right = 0] = (el.getAttribute('data-rect') ?? '').split(',').map(Number);
  return { left, right, top: 0, width: right - left, height: right - left ? 40 : 0 };
};

function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

const NOW = new Date(2026, 9, 20, 15, 0); // Tue 20 Oct 2026, 15:00

describe('threadIdFromPath', () => {
  it('reads the thread id', () => {
    expect(threadIdFromPath('/direct/t/103742304360675/')).toBe('103742304360675');
    expect(threadIdFromPath('/direct/t/abc_123?x=1')).toBe('abc_123');
    expect(threadIdFromPath('/direct/t/a%20b/')).toBeNull();
    expect(threadIdFromPath('/direct/inbox/')).toBeNull();
    expect(threadIdFromPath('/p/C0ffee/')).toBeNull();
  });
});

describe('parseDividerTime', () => {
  const at = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
  it.each([
    ['Today 10:42', at(2026, 10, 20, 10, 42)],
    ['Yesterday 9:05 PM', at(2026, 10, 19, 21, 5)],
    ['Mon 15:20', at(2026, 10, 19, 15, 20)],
    ['Sat 08:00', at(2026, 10, 17, 8, 0)],
    ['Tue 10:00', at(2026, 10, 13, 10, 0)], // a weekday label is never today
    ['Oct 3, 2026, 9:15 AM', at(2026, 10, 3, 9, 15)],
    ['3 Oct 2026', at(2026, 10, 3)],
    ['October 3 at 10:42 AM', at(2026, 10, 3, 10, 42)],
    ['10:42', at(2026, 10, 20, 10, 42)],
    // The day is never read from the hour.
    ['Oct 10, 2026, 10:05 AM', at(2026, 10, 10, 10, 5)],
    ['Oct 9, 2026, 9:15 AM', at(2026, 10, 9, 9, 15)],
    ['Oct 1, 2026, 11:30', at(2026, 10, 1, 11, 30)],
    ['Oct 2, 2026, 12:40', at(2026, 10, 2, 12, 40)],
    ['October 12 at 12:30 PM', at(2026, 10, 12, 12, 30)],
    ['Monday 10:42', at(2026, 10, 19, 10, 42)],
    ['Tuesday 9:05 PM', at(2026, 10, 13, 21, 5)],
    // Nothing lands in the future: a tab left open past midnight still says "Today".
    ['Today 22:15', at(2026, 10, 19, 22, 15)],
    ['22:15', at(2026, 10, 19, 22, 15)],
    ['Today 15:03', at(2026, 10, 20, 15, 3)], // a few minutes of clock skew are fine
  ])('%s', (label, expected) => expect(parseDividerTime(label, NOW)).toBe(expected));
  it('moves year-less dates from the future into last year, and rejects other future dates', () => {
    const jan5 = new Date(2027, 0, 5, 10, 0);
    expect(parseDividerTime('December 28 at 10:42 PM', jan5)).toBe(at(2026, 12, 28, 22, 42));
    expect(parseDividerTime('Dec 20 10:00', jan5)).toBe(at(2026, 12, 20, 10, 0));
    expect(parseDividerTime('Oct 25, 2026', NOW)).toBeNull();
  });
  it('gives up on labels it cannot read', () => {
    expect(parseDividerTime('Hoje 10:42'.replace('10:42', 'às dez'), NOW)).toBeNull();
  });
});

describe('isDividerLabel', () => {
  it.each([
    'Today 10:42',
    'Yesterday 9:05 PM',
    'Mon 15:20',
    'Monday 10:42',
    'Tuesday 9:05 PM',
    'Oct 3, 2026, 9:15 AM',
    'October 3 at 10:42 AM',
    '3 Oct 2026',
    'Mon, Oct 19, 2026, 10:00',
    '10:42',
    '9:05\u202fPM',
  ])('reads %s as a divider', (label) => expect(isDividerLabel(label)).toBe(true));
  it.each([
    'Maybe at 5?',
    'Marco has 2 tickets',
    'Decent 9/10',
    'Decent 9',
    'Sunday?',
    'see you at 10:30',
    'Oct 3 was fun',
  ])('leaves message text alone: %s', (text) => expect(isDividerLabel(text)).toBe(false));
});

describe('readInstagramThread', () => {
  it('finds the scroll container by structure, not class names', () => {
    expect(findScrollContainer(page(THREAD))?.className).toBe('x9scroll');
  });

  it('reads messages in order with direction, times, media and placeholders', () => {
    const capture = readInstagramThread(page(THREAD), '103742304360675', rectOf, NOW)!;
    expect(capture.thread).toEqual({ id: '103742304360675', title: 'Maya Lopez', isGroup: false });
    const oct3 = new Date(2026, 9, 3, 9, 15).getTime();
    const today = new Date(2026, 9, 20, 10, 42).getTime();
    expect(capture.messages).toEqual([
      { senderName: 'Maya Lopez', fromSelf: false, text: 'hey!', timestamp: oct3, attachments: [] },
      { senderName: '', fromSelf: true, text: 'hi :)', timestamp: oct3, attachments: [] },
      {
        senderName: 'Maya Lopez',
        fromSelf: false,
        text: null,
        timestamp: today,
        attachments: [{ type: 'image', url: 'https://scontent.cdninstagram.com/photo.jpg' }],
      },
      {
        senderName: 'Maya Lopez',
        fromSelf: false,
        text: null,
        timestamp: today,
        attachments: [{ type: 'other', name: 'Not viewable on the web' }],
      },
      { senderName: '', fromSelf: true, text: null, timestamp: today, attachments: [{ type: 'sticker' }] },
      {
        senderName: 'Maya Lopez',
        fromSelf: false,
        text: 'look at this',
        timestamp: today,
        attachments: [{ type: 'link', url: 'https://www.instagram.com/p/C0ffee/', name: 'Shared post' }],
      },
    ]);
  });

  it('names senders in group threads from their avatars, carrying names through a run', () => {
    const group = `
      <div role="main">
        <div><span title="Weekend plans">Weekend plans</span></div>
        <div style="overflow-y: auto">
          <div role="group"><div role="article"><span dir="auto">who's driving?</span></div><img alt="sam_r's profile picture" src="a.jpg"></div>
          <div role="group"><div role="article"><span dir="auto">not me</span></div></div>
          <div role="group"><div role="article"><span dir="auto">I can</span></div><img alt="jo.k's profile picture" src="b.jpg"></div>
        </div>
      </div>`;
    const capture = readInstagramThread(page(group), '42', rectOf, NOW)!;
    expect(capture.thread).toEqual({
      id: '42',
      title: 'Weekend plans',
      isGroup: true,
      participants: ['sam_r', 'jo.k'],
    });
    expect(capture.messages.map((m) => [m.senderName, m.text])).toEqual([
      ['sam_r', "who's driving?"],
      ['sam_r', 'not me'],
      ['jo.k', 'I can'],
    ]);
  });

  it('falls back to role="presentation" bubbles on the other layout', () => {
    const alt = `
      <div role="main"><div style="overflow-y: scroll">
        <div role="presentation"><span dir="auto">first</span></div>
        <div style="display: flex; justify-content: flex-end"><div role="presentation"><span dir="auto">second</span></div></div>
      </div></div>`;
    const capture = readInstagramThread(page(alt), '7', rectOf, NOW)!;
    expect(capture.messages.map((m) => [m.fromSelf, m.text])).toEqual([
      [false, 'first'],
      [true, 'second'],
    ]);
  });

  it('returns null when no thread is on screen, and diagnoses what it sees', () => {
    expect(readInstagramThread(page('<div role="main"><p>Your messages</p></div>'), '1', rectOf)).toBeNull();
    const d = diagnose(page(THREAD), rectOf, '1');
    expect(d).toMatchObject({ container: true, articles: 7, read: 6, outgoing: 2, incoming: 4, title: 'Maya Lopez' });
    expect(d.dividers).toEqual(['Oct 3, 2026, 9:15 AM', 'Today 10:42']);
  });
});

describe('readInstagramThread, the hard cases', () => {
  const thread = (header: string, rows: string) => `
    <div role="main">
      <div>${header}</div>
      <div style="overflow-y: auto">${rows}</div>
    </div>`;

  it('keeps one-word messages that look like Instagram’s own labels', () => {
    const doc = page(
      thread(
        '<a href="/maya.lopez/"><span title="Maya Lopez">Maya Lopez</span></a>',
        `<div role="group"><div role="article"><div><span dir="auto">Like</span></div></div></div>
         <div role="group" style="display: flex; justify-content: flex-end"><div role="article"><div><span dir="auto">Copy</span></div><span dir="auto">Seen</span></div></div>
         <div role="group"><div role="article"><div><span dir="auto">ok then</span></div><div role="button"><span dir="auto">Reply</span></div></div></div>`,
      ),
    );
    const capture = readInstagramThread(doc, '1', rectOf, NOW)!;
    expect(capture.messages.map((m) => [m.fromSelf, m.text])).toEqual([
      [false, 'Like'],
      [true, 'Copy'],
      [false, 'ok then'],
    ]);
  });

  it('leaves isGroup unset when the window can’t tell, and never names a sender after the thread', () => {
    const doc = page(
      thread(
        '<span title="Weekend plans">Weekend plans</span>',
        `<div role="group"><div role="article"><span dir="auto">who's driving?</span></div><img alt="sam_r's profile picture" src="a.jpg"></div>
         <div role="group"><div role="article"><span dir="auto">anyone?</span></div></div>`,
      ),
    );
    const capture = readInstagramThread(doc, '42', rectOf, NOW)!;
    expect(capture.thread).toEqual({ id: '42', title: 'Weekend plans' });
    expect(capture.messages.map((m) => m.senderName)).toEqual(['sam_r', 'sam_r']);

    const noAvatars = page(
      thread(
        '<span title="Weekend plans">Weekend plans</span>',
        '<div role="group"><div role="article"><span dir="auto">hi</span></div></div>',
      ),
    );
    expect(readInstagramThread(noAvatars, '42', rectOf, NOW)!.messages[0]!.senderName).toBe('');
  });

  it('trusts the header: a member count means a group, one profile link means a 1:1', () => {
    const rows =
      '<div role="group"><div role="article"><span dir="auto">see you there</span></div><img alt="sam_r\'s profile picture" src="a.jpg"></div>';
    const group = readInstagramThread(
      page(thread('<span title="Weekend plans">Weekend plans</span><span>4 members</span>', rows)),
      '42',
      rectOf,
      NOW,
    )!;
    expect(group.thread).toMatchObject({ isGroup: true, participants: ['sam_r'] });
    expect(group.messages[0]!.senderName).toBe('sam_r');

    const oneToOne = readInstagramThread(
      page(thread('<a href="/sam_r/"><span title="Sam R">Sam R</span></a>', rows)),
      '43',
      rectOf,
      NOW,
    )!;
    expect(oneToOne.thread.isGroup).toBe(false);
    expect(oneToOne.messages[0]!.senderName).toBe('Sam R');
  });

  it('ignores the avatars and links inside a shared post or a mention', () => {
    const doc = page(
      thread(
        '<a href="/maya.lopez/"><span title="Maya Lopez">Maya Lopez</span></a>',
        `<div role="group"><div role="article"><span dir="auto">hey</span></div><img alt="maya.lopez's profile picture" src="m.jpg"></div>
         <div role="group"><div role="article">
           <a href="/p/C0ffee/"><img alt="natgeo's profile picture" src="n.jpg"><a href="/natgeo/">natgeo</a><img src="https://scontent.cdninstagram.com/t.jpg" width="150" height="150"></a>
         </div></div>
         <div role="group"><div role="article"><span dir="auto">ask <a href="/jo.k/">@jo.k</a></span></div></div>`,
      ),
    );
    const capture = readInstagramThread(doc, '1', rectOf, NOW)!;
    expect(capture.thread).toEqual({ id: '1', title: 'Maya Lopez', isGroup: false });
    expect(capture.messages.map((m) => m.senderName)).toEqual(['Maya Lopez', 'Maya Lopez', 'Maya Lopez']);
  });

  it('says whether the window reaches the newest message', () => {
    const doc = page(THREAD);
    const scroller = findScrollContainer(doc)!;
    expect(readInstagramThread(doc, '1', rectOf, NOW)!.atBottom).toBe(true);
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: -600 });
    expect(readInstagramThread(doc, '1', rectOf, NOW)!.atBottom).toBe(false);

    // A list that scrolls the usual way is at the newest message at the end.
    scroller.style.flexDirection = 'column';
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 });
    expect(readInstagramThread(doc, '1', rectOf, NOW)!.atBottom).toBe(false);
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 1500 });
    expect(readInstagramThread(doc, '1', rectOf, NOW)!.atBottom).toBe(true);
  });
});

describe('content script', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('announces its thread, resends captures the server didn’t take, and stops reading history when the thread changes', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/direct/t/42/');
    page(THREAD);
    const sent: { type: string; [key: string]: unknown }[] = [];
    const results = [
      { ok: false, status: 503 }, // the server is still starting
      { ok: true, status: 200 },
    ];
    const listeners: ((message: unknown, sender: unknown, reply: (value: unknown) => void) => void)[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (message: { type: string }) => {
          sent.push(message);
          return message.type === 'capture' ? (results.shift() ?? { ok: true, status: 200 }) : undefined;
        }),
        onMessage: { addListener: (fn: (typeof listeners)[number]) => listeners.push(fn) },
      },
    });
    vi.resetModules();
    // Not a static import: the server's typecheck has no `chrome` types for the content script.
    const contentScript = '../extension/src/content/instagram';
    await import(/* @vite-ignore */ contentScript);
    const captures = () => sent.filter((m) => m.type === 'capture');

    expect(sent[0]).toEqual({ type: 'thread', threadId: '42' });
    await vi.advanceTimersByTimeAsync(800);
    expect(captures()).toHaveLength(1);
    expect((captures()[0]!.capture as { atBottom: boolean }).atBottom).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000); // the heartbeat sends it again
    expect(captures()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000); // taken, so not again
    expect(captures()).toHaveLength(2);

    const reply = vi.fn();
    listeners[0]!({ type: 'get-thread' }, {}, reply);
    expect(reply).toHaveBeenCalledWith('42');

    listeners[0]!({ type: 'read-history', maxSteps: 10 }, {}, () => {});
    history.replaceState(null, '', '/direct/t/43/');
    await vi.advanceTimersByTimeAsync(1600);
    expect(sent.filter((m) => m.type === 'history-progress').at(-1)).toMatchObject({
      done: true,
      reason: 'Conversation changed',
    });
  });
});
