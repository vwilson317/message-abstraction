import type { HubEvent } from './api';

/** Server events plus one of our own: the stream (re)connected, so refetch anything cached. */
export type ClientEvent = HubEvent | { type: 'stream.open' };

const EVENT_TYPES: HubEvent['type'][] = [
  'conversation.upserted',
  'conversation.deleted',
  'message.upserted',
  'messages.bulk',
  'connector.status',
  'settings.updated',
];

const listeners = new Set<(event: ClientEvent) => void>();
let source: EventSource | null = null;

function dispatch(event: ClientEvent) {
  for (const listener of listeners) listener(event);
}

function connect() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => dispatch({ type: 'stream.open' });
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (e) => dispatch(JSON.parse((e as MessageEvent<string>).data) as HubEvent));
  }
}

/** One shared EventSource for the whole app; the browser reconnects it automatically. */
export function subscribe(listener: (event: ClientEvent) => void): () => void {
  listeners.add(listener);
  connect();
  return () => listeners.delete(listener);
}
