import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Conversation, type ConnectorStatus } from './api';
import { subscribe } from './events';

function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => (b.lastMessageAt ?? -Infinity) - (a.lastMessageAt ?? -Infinity));
}

/** Conversations and sources, kept current from the server's event stream. */
export function useInbox(onError: (message: string) => void, onDeleted?: (conversationId: string) => void) {
  const deletedRef = useRef(onDeleted);
  deletedRef.current = onDeleted;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [convs, conns] = await Promise.all([api.conversations(), api.connectors()]);
      setConversations(sortConversations(convs));
      setConnectors(conns);
    } catch (err) {
      onError(`Couldn't reach the server: ${(err as Error).message}`);
    } finally {
      setLoaded(true);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    return subscribe((event) => {
      switch (event.type) {
        case 'stream.open':
          void refresh();
          break;
        case 'conversation.upserted':
          setConversations((list) =>
            sortConversations([...list.filter((c) => c.id !== event.conversation.id), event.conversation]),
          );
          break;
        case 'conversation.deleted':
          setConversations((list) => list.filter((c) => c.id !== event.conversationId));
          deletedRef.current?.(event.conversationId);
          break;
        case 'connector.status':
          setConnectors((list) =>
            list.some((c) => c.id === event.status.id)
              ? list.map((c) => (c.id === event.status.id ? event.status : c))
              : [...list, event.status],
          );
          break;
      }
    });
  }, [refresh]);

  return { conversations, connectors, loaded };
}
