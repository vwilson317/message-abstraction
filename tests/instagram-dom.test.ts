// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  diagnose,
  findScrollContainer,
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
  it('reads the numeric thread id', () => {
    expect(threadIdFromPath('/direct/t/103742304360675/')).toBe('103742304360675');
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
  ])('%s', (label, expected) => expect(parseDividerTime(label, NOW)).toBe(expected));
  it('gives up on labels it cannot read', () => {
    expect(parseDividerTime('Hoje 10:42'.replace('10:42', 'às dez'), NOW)).toBeNull();
  });
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
