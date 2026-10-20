import type { CaptureResult, ExtensionMessage } from '../shared';
import { diagnose, findScrollContainer, readInstagramThread, threadIdFromPath } from './instagram-dom';

/**
 * Runs on instagram.com. By default it only reads what's already on screen:
 * no requests of its own, no clicking, no scrolling. When the conversation
 * changes it sends a snapshot of the visible messages to the service worker.
 *
 * The one exception is "Read earlier messages", which you start yourself from
 * the side panel: it scrolls the thread back slowly so Instagram loads older
 * messages, which the observer then captures like any other.
 */

const SETTLE_MS = 700;
const HEARTBEAT_MS = 30_000;

let threadId = threadIdFromPath(location.pathname);
/** The last snapshot the server took, and the one on its way there. */
let lastSent = '';
let inFlight = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

function send(message: ExtensionMessage): Promise<unknown> {
  if (!alive) return Promise.resolve(undefined);
  try {
    return chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // The extension was reloaded or removed; this copy of the script is orphaned.
    alive = false;
    observer.disconnect();
    return Promise.resolve(undefined);
  }
}

/** Tell the service worker which thread this tab shows, so the side panel can follow. */
function announce(): void {
  void send({ type: 'thread', threadId });
}

/** Worth sending again: the server wasn't reachable, was starting up, or was busy. */
function retryable(result: CaptureResult | undefined): boolean {
  if (!result) return true;
  const { ok, status } = result;
  return !ok && (status === 0 || status >= 500 || status === 408 || status === 429);
}

function capture(): void {
  const id = threadIdFromPath(location.pathname);
  if (id !== threadId) {
    threadId = id;
    lastSent = '';
    announce();
  }
  if (!id) return;
  const snapshot = readInstagramThread(document, id);
  if (!snapshot || snapshot.messages.length === 0) return;
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastSent || serialized === inFlight) return;
  inFlight = serialized;
  void send({ type: 'capture', capture: snapshot, threadId: id }).then((result) => {
    if (inFlight === serialized) inFlight = '';
    // Only a snapshot the server took counts as sent; the rest go again on the next change or heartbeat.
    if (!retryable(result as CaptureResult | undefined)) lastSent = serialized;
  });
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(capture, SETTLE_MS);
}

// Instagram is a single-page app: navigation and new messages both show up as DOM changes.
const observer = new MutationObserver(schedule);
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
announce();
schedule();

setInterval(() => {
  if (!location.pathname.startsWith('/direct')) return;
  void send({ type: 'heartbeat' });
  capture(); // resends a snapshot the server didn't take
}, HEARTBEAT_MS);
void send({ type: 'heartbeat' });

// Leaving the page (reload, another site) ends this thread; coming back from the back/forward cache resumes it.
addEventListener('pagehide', () => void send({ type: 'thread', threadId: null }));
addEventListener('pageshow', (e) => {
  if (e.persisted) announce();
});

// ── Reading history on request ─────────────────────────────────────────────

const STEP_PAUSE_MS = 1500;
const LOAD_TIMEOUT_MS = 8000;
let historyRun = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Instagram shows a loading skeleton while it fetches an older page. */
function loading(): boolean {
  return document.querySelector('[role="progressbar"][data-visualcompletion="loading-state"]') !== null;
}

let stopReason = 'Stopped';

async function readHistory(maxSteps: number): Promise<void> {
  const run = ++historyRun;
  stopReason = 'Stopped';
  const thread = threadIdFromPath(location.pathname);
  const report = (steps: number, done: boolean, reason?: string) =>
    void send({ type: 'history-progress', steps, done, ...(reason && { reason }) });
  if (!thread) return report(0, true, 'No conversation open');
  // Scrolling yourself takes over: the read stops rather than fight you.
  const takeOver = (e: Event) => {
    if (!e.isTrusted || run !== historyRun) return;
    stopReason = 'Stopped because you scrolled';
    historyRun++;
  };
  addEventListener('wheel', takeOver, { capture: true, passive: true });
  addEventListener('touchmove', takeOver, { capture: true, passive: true });
  /** Why to stop now, if anything changed under the read. */
  const interrupted = () =>
    run !== historyRun ? stopReason : threadIdFromPath(location.pathname) !== thread ? 'Conversation changed' : null;
  try {
    let unchanged = 0;
    for (let step = 1; step <= maxSteps; step++) {
      const before = interrupted();
      if (before) return report(step - 1, true, before);
      const container = findScrollContainer(document);
      if (!container) return report(step - 1, true, 'No conversation open');
      const heightBefore = container.scrollHeight;
      const topBefore = container.scrollTop;
      // The list is column-reverse: older messages are at more negative scrollTop.
      container.scrollTop -= container.clientHeight * 0.75;
      const moved = container.scrollTop !== topBefore;
      await sleep(STEP_PAUSE_MS);
      const deadline = performance.now() + LOAD_TIMEOUT_MS;
      while (loading() && performance.now() < deadline) await sleep(250);
      const after = interrupted();
      if (after) return report(step - 1, true, after);
      capture();
      // At the top, nothing moves and nothing more loads.
      unchanged = moved || container.scrollHeight !== heightBefore ? 0 : unchanged + 1;
      report(step, false);
      if (unchanged >= 3) return report(step, true, 'Reached the beginning');
    }
    report(maxSteps, true, 'Stopped at the step limit');
  } finally {
    removeEventListener('wheel', takeOver, { capture: true });
    removeEventListener('touchmove', takeOver, { capture: true });
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'read-history') void readHistory(Math.min(Math.max(message.maxSteps, 1), 200));
  if (message.type === 'stop-history') {
    stopReason = 'Stopped';
    historyRun++;
  }
  if (message.type === 'diagnose') sendResponse(diagnose(document));
  if (message.type === 'get-thread') sendResponse(threadIdFromPath(location.pathname));
  return false;
});
