import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Conversation, type ConnectorStatus, type Message } from '../api';
import { subscribe } from '../events';
import { dayLabel, plural, sameDay } from '../format';
import { Avatar } from './Avatar';
import { MessageBubble } from './MessageBubble';

interface Props {
  conversation: Conversation;
  connector: ConnectorStatus | undefined;
  /** Without these the thread renders headerless, for the companion view. */
  header?: { insightsOpen: boolean; onToggleInsights: () => void; onBack: () => void };
  onOpenSources: () => void;
  onError: (message: string) => void;
}

function insertSorted(list: Message[], message: Message): Message[] {
  const without = list.filter((m) => m.id !== message.id);
  const at = without.findIndex((m) => m.timestamp > message.timestamp);
  if (at === -1) return [...without, message];
  return [...without.slice(0, at), message, ...without.slice(at)];
}

/** Messages for one conversation: newest page first, older pages on demand, live updates. */
function useMessages(conversationId: string, onError: (message: string) => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadingOlder = useRef(false);

  const reload = useCallback(async () => {
    try {
      const page = await api.messages(conversationId);
      setMessages(page.messages);
      setCursor(page.nextCursor);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conversationId, onError]);

  useEffect(() => {
    void reload();
    return subscribe((event) => {
      if (event.type === 'message.upserted' && event.message.conversationId === conversationId) {
        setMessages((list) => insertSorted(list, event.message));
      } else if (
        (event.type === 'messages.bulk' && event.conversationId === conversationId) ||
        event.type === 'stream.open'
      ) {
        void reload();
      }
    });
  }, [conversationId, reload]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder.current) return;
    loadingOlder.current = true;
    try {
      const page = await api.messages(conversationId, cursor);
      setMessages((list) => [...page.messages.filter((m) => !list.some((x) => x.id === m.id)), ...list]);
      setCursor(page.nextCursor);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      loadingOlder.current = false;
    }
  }, [conversationId, cursor, onError]);

  return { messages, loading, hasOlder: cursor !== null, loadOlder };
}

export function Thread(props: Props) {
  const { conversation, connector, onError } = props;
  const { messages, loading, hasOlder, loadOlder } = useMessages(conversation.id, onError);
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const stickToBottom = useRef(true);

  // Keep the view pinned: to the bottom for new messages, in place when older ones load above.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    maybeLoadOlder();
  };

  const maybeLoadOlder = () => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollTop < 300 && hasOlder && !anchor.current) {
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      void loadOlder().then(() => {
        // Nothing was added (or it failed): drop the anchor so the next scroll can retry.
        requestAnimationFrame(() => {
          anchor.current = null;
        });
      });
    }
  };

  // A short first page can't be scrolled, so fetch more until the view fills up.
  useEffect(() => {
    const el = scroller.current;
    if (el && !loading && el.scrollHeight <= el.clientHeight) maybeLoadOlder();
  });

  // Clear the unread badge while the conversation is open and the tab is visible.
  useEffect(() => {
    if (conversation.unreadCount > 0 && document.visibilityState === 'visible') {
      api.markRead(conversation.id).catch(() => {});
    }
  }, [conversation.id, conversation.unreadCount]);

  const days = useMemo(() => {
    const groups: { key: string; messages: Message[] }[] = [];
    for (const m of messages) {
      const last = groups.at(-1);
      if (last && sameDay(last.messages[0]!.timestamp, m.timestamp)) last.messages.push(m);
      else groups.push({ key: m.id, messages: [m] });
    }
    return groups;
  }, [messages]);

  const appName = conversation.platform === 'whatsapp' ? 'WhatsApp' : 'Instagram';
  const footerNote =
    conversation.sourceKind === 'import'
      ? 'Imported conversation — read only'
      : connector?.state === 'connected'
        ? `Mirrored from ${connector.label} — reply there`
        : `${connector?.label ?? appName} isn't being watched right now`;

  const subtitle = [
    conversation.platform === 'whatsapp' ? 'WhatsApp' : 'Instagram',
    conversation.isGroup ? plural(conversation.participants.length, 'participant') : null,
    conversation.sourceKind === 'import' ? `imported · ${plural(conversation.messageCount, 'message')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <main className="thread">
      {props.header && (
        <header className="thread-header">
          <button className="icon-btn back-btn" onClick={props.header.onBack} aria-label="Back to conversations">
            ‹
          </button>
          <Avatar name={conversation.title} platform={conversation.platform} size={38} />
          <div className="thread-heading">
            <h2>{conversation.title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            className={`btn btn-quiet ${props.header.insightsOpen ? 'active' : ''}`}
            onClick={props.header.onToggleInsights}
            aria-pressed={props.header.insightsOpen}
          >
            Insights
          </button>
        </header>
      )}

      <div className="messages" ref={scroller} onScroll={onScroll}>
        {!loading && hasOlder && <div className="load-more">Loading earlier messages…</div>}
        {!loading && !hasOlder && messages.length > 0 && <div className="load-more">Beginning of conversation</div>}
        {!loading && messages.length === 0 && <div className="load-more">No messages yet</div>}
        {days.map((day) => (
          // One section per day, so each day's sticky header gives way to the next.
          <section key={day.key} className="day">
            <div className="day-separator">
              <span>{dayLabel(day.messages[0]!.timestamp)}</span>
            </div>
            {day.messages.map((m, i) => {
              const prev = day.messages[i - 1];
              const grouped =
                !!prev &&
                prev.senderId === m.senderId &&
                prev.kind !== 'system' &&
                m.timestamp - prev.timestamp < 5 * 60_000;
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  showSender={conversation.isGroup && !m.fromSelf && !grouped}
                  grouped={grouped}
                />
              );
            })}
          </section>
        ))}
      </div>

      <footer className="composer">
        <div className="composer-disabled">
          {footerNote}
          {conversation.sourceKind === 'live' && connector?.state !== 'connected' && (
            <button className="btn btn-quiet" onClick={props.onOpenSources}>
              Sources
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}
