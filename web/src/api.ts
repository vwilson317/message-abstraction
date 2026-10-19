import type { ConversationStats } from '../../src/insights/stats';
import type { Conversation, ConnectorStatus, Message, MessagePage, Platform } from '../../src/core/types';

export type { ConversationStats };
export type * from '../../src/core/types';

export interface ImportSummary {
  conversations: { id: string; title: string; platform: Platform; messageCount: number; selfName: string | null }[];
  warnings: string[];
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

const enc = encodeURIComponent;

export const api = {
  connectors: () => request<ConnectorStatus[]>('/api/connectors'),
  connect: (id: string) => request<void>(`/api/connectors/${enc(id)}/connect`, { method: 'POST' }),
  disconnect: (id: string) => request<void>(`/api/connectors/${enc(id)}/disconnect`, { method: 'POST' }),
  logout: (id: string) => request<void>(`/api/connectors/${enc(id)}/logout`, { method: 'POST' }),

  conversations: () => request<Conversation[]>('/api/conversations'),
  setSelf: (id: string, selfParticipantId: string | null) =>
    request<Conversation>(`/api/conversations/${enc(id)}`, json('PATCH', { selfParticipantId })),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${enc(id)}`, { method: 'DELETE' }),
  markRead: (id: string) => request<Conversation>(`/api/conversations/${enc(id)}/read`, { method: 'POST' }),

  messages: (id: string, before?: string) =>
    request<MessagePage>(`/api/conversations/${enc(id)}/messages?limit=60${before ? `&before=${enc(before)}` : ''}`),
  send: (id: string, text: string) =>
    request<Message>(`/api/conversations/${enc(id)}/messages`, json('POST', { text })),

  insights: (id: string) => request<ConversationStats>(`/api/conversations/${enc(id)}/insights`),
  transcript: (id: string, last?: number) =>
    request<string>(`/api/conversations/${enc(id)}/transcript${last ? `?last=${last}` : ''}`),
  transcriptUrl: (id: string, last?: number) =>
    `/api/conversations/${enc(id)}/transcript?download${last ? `&last=${last}` : ''}`,

  importFile: (file: File, options: { selfName?: string; dateOrder?: string }) => {
    const form = new FormData();
    form.set('file', file);
    if (options.selfName) form.set('selfName', options.selfName);
    if (options.dateOrder) form.set('dateOrder', options.dateOrder);
    return request<ImportSummary>('/api/import', { method: 'POST', body: form });
  },
};
