import type { ExtensionMessage } from '../shared';
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

let threadId: string | null = null;
let lastSent = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

function send(message: ExtensionMessage): void {
  if (!alive) return;
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // The extension was reloaded or removed; this copy of the script is orphaned.
    alive = false;
    observer.disconnect();
  }
}

function capture(): void {
  const id = threadIdFromPath(location.pathname);
  if (id !== threadId) {
    if (threadId && !id) send({ type: 'left-thread' });
    threadId = id;
    lastSent = '';
  }
  if (!id) return;
  const snapshot = readInstagramThread(document, id);
  if (!snapshot || snapshot.messages.length === 0) return;
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastSent) return;
  lastSent = serialized;
  send({ type: 'capture', capture: snapshot, threadId: id });
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(capture, SETTLE_MS);
}

// Instagram is a single-page app: navigation and new messages both show up as DOM changes.
const observer = new MutationObserver(schedule);
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
schedule();

setInterval(() => {
  if (location.pathname.startsWith('/direct')) send({ type: 'heartbeat' });
}, HEARTBEAT_MS);
send({ type: 'heartbeat' });

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

async function readHistory(maxSteps: number): Promise<void> {
  const run = ++historyRun;
  const report = (steps: number, done: boolean, reason?: string) =>
    send({ type: 'history-progress', steps, done, ...(reason && { reason }) });
  let unchanged = 0;
  for (let step = 1; step <= maxSteps; step++) {
    const container = findScrollContainer(document);
    if (run !== historyRun) return report(step - 1, true, 'Stopped');
    if (!container || !threadIdFromPath(location.pathname)) return report(step - 1, true, 'No conversation open');
    const heightBefore = container.scrollHeight;
    const topBefore = container.scrollTop;
    // The list is column-reverse: older messages are at more negative scrollTop.
    container.scrollTop -= container.clientHeight * 0.75;
    const moved = container.scrollTop !== topBefore;
    await sleep(STEP_PAUSE_MS);
    const deadline = performance.now() + LOAD_TIMEOUT_MS;
    while (loading() && performance.now() < deadline) await sleep(250);
    capture();
    // At the top, nothing moves and nothing more loads.
    unchanged = moved || container.scrollHeight !== heightBefore ? 0 : unchanged + 1;
    report(step, false);
    if (unchanged >= 3) return report(step, true, 'Reached the beginning');
  }
  report(maxSteps, true, 'Stopped at the step limit');
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'read-history') void readHistory(Math.min(Math.max(message.maxSteps, 1), 200));
  if (message.type === 'stop-history') historyRun++;
  if (message.type === 'diagnose') sendResponse(diagnose(document));
  return false;
});
