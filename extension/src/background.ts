import { conversationIdFor, getServer, SOURCE_ID, type ExtensionMessage } from './shared';

/**
 * Relays what the content script reads to the local server. Requests go from
 * here, not from the page, so instagram.com never talks to localhost and the
 * server can tell them apart by their chrome-extension:// origin.
 */

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

async function post(path: string, body?: unknown): Promise<Response> {
  const server = await getServer();
  return fetch(`${server}/api/connectors/${SOURCE_ID}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/** Which thread each Instagram tab has open. Session storage survives the worker sleeping. */
async function setTabThread(tabId: number, threadId: string | null): Promise<void> {
  const key = `tab:${tabId}`;
  if (threadId) await chrome.storage.session.set({ [key]: threadId });
  else await chrome.storage.session.remove(key);
}

async function activeThread(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return null;
  const key = `tab:${tab.id}`;
  const stored = await chrome.storage.session.get(key);
  return typeof stored[key] === 'string' ? stored[key] : null;
}

async function announceActiveThread(): Promise<void> {
  const threadId = await activeThread();
  const message: ExtensionMessage = {
    type: 'thread-changed',
    conversationId: threadId ? conversationIdFor(threadId) : null,
  };
  // The side panel may be closed; that's fine.
  chrome.runtime.sendMessage(message).catch(() => {});
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  switch (message.type) {
    case 'capture':
      if (tabId === undefined) return false;
      void (async () => {
        await setTabThread(tabId, message.threadId);
        try {
          const res = await post('captures', message.capture);
          sendResponse({ ok: res.ok, status: res.status });
        } catch {
          sendResponse({ ok: false, status: 0 });
        }
        await announceActiveThread();
      })();
      return true;
    case 'heartbeat':
      post('heartbeat').catch(() => {});
      return false;
    case 'left-thread':
      if (tabId !== undefined) void setTabThread(tabId, null).then(announceActiveThread);
      return false;
    case 'get-active-thread':
      void activeThread().then((threadId) => sendResponse(threadId ? conversationIdFor(threadId) : null));
      return true;
    default:
      return false;
  }
});

chrome.tabs.onActivated.addListener(() => void announceActiveThread());
chrome.tabs.onRemoved.addListener((tabId) => void setTabThread(tabId, null));
