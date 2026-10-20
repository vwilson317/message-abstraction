import { getServer, setServer, type ExtensionMessage } from './shared';

/**
 * The side panel is a thin frame around the local app's companion view, so
 * the panel and the full inbox share one UI. It tells the frame which
 * conversation the active Instagram tab has open.
 */

const frame = document.getElementById('app') as HTMLIFrameElement;
const setup = document.getElementById('setup') as HTMLDivElement;
const serverInput = document.getElementById('server') as HTMLInputElement;
let server = '';
let current: string | null = null;

function focus(conversationId: string | null): void {
  current = conversationId;
  frame.contentWindow?.postMessage({ type: 'focus', conversationId }, server);
}

async function connect(): Promise<void> {
  server = await getServer();
  serverInput.value = server;
  try {
    const res = await fetch(`${server}/api/health`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    frame.hidden = true;
    setup.hidden = false;
    setTimeout(() => void connect(), 5000);
    return;
  }
  setup.hidden = true;
  frame.hidden = false;
  if (!frame.src.startsWith(server)) {
    frame.src = `${server}/?view=companion&embed=extension`;
    frame.addEventListener('load', () => focus(current), { once: true });
  }
  const conversationId = (await chrome.runtime.sendMessage({
    type: 'get-active-thread',
  } satisfies ExtensionMessage)) as string | null;
  focus(conversationId);
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === 'thread-changed') focus(message.conversationId);
  if (message.type === 'history-progress') frame.contentWindow?.postMessage(message, server);
});

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

// The frame (the local app) asks for things only the extension can do.
window.addEventListener('message', (event) => {
  if (event.origin !== server) return;
  const data = event.data as { type?: string; maxSteps?: number } | null;
  if (data?.type === 'ready') focus(current);
  if (data?.type === 'read-history' || data?.type === 'stop-history' || data?.type === 'diagnose') {
    void activeTabId().then(async (tabId) => {
      if (tabId === undefined) return;
      const message: ExtensionMessage =
        data.type === 'read-history'
          ? { type: 'read-history', maxSteps: data.maxSteps ?? 40 }
          : data.type === 'stop-history'
            ? { type: 'stop-history' }
            : { type: 'diagnose' };
      try {
        const reply = await chrome.tabs.sendMessage(tabId, message);
        if (data.type === 'diagnose') frame.contentWindow?.postMessage({ type: 'diagnosis', diagnosis: reply }, server);
      } catch {
        frame.contentWindow?.postMessage(
          { type: 'extension-error', error: 'Open an Instagram conversation in this window first.' },
          server,
        );
      }
    });
  }
});

document.getElementById('save')!.addEventListener('click', () => {
  void setServer(serverInput.value).then(connect);
});

void connect();
