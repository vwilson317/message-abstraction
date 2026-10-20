/** Messages passed between the content script, the service worker and the side panel. */
export type ExtensionMessage =
  | { type: 'capture'; capture: unknown; threadId: string }
  | { type: 'heartbeat' }
  | { type: 'left-thread' }
  | { type: 'get-active-thread' }
  | { type: 'thread-changed'; conversationId: string | null }
  /** Side panel → content script: scroll back through the open thread, slowly, to read older messages. */
  | { type: 'read-history'; maxSteps: number }
  | { type: 'stop-history' }
  /** Content script → side panel: how a history read is going. */
  | { type: 'history-progress'; steps: number; done: boolean; reason?: string }
  /** Side panel → content script: report what the reader can see. */
  | { type: 'diagnose' };

export const SOURCE_ID = 'instagram-web';
export const DEFAULT_SERVER = 'http://localhost:4310';

export async function getServer(): Promise<string> {
  const { server } = await chrome.storage.local.get('server');
  return typeof server === 'string' && server ? server.replace(/\/$/, '') : DEFAULT_SERVER;
}

export async function setServer(server: string): Promise<void> {
  await chrome.storage.local.set({ server: server.replace(/\/$/, '') });
}

export function conversationIdFor(threadId: string): string {
  return `${SOURCE_ID}:${threadId}`;
}
