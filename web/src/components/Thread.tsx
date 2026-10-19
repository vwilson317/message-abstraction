import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, type Conversation, type ConnectorStatus, type Message } from '../api';
import { subscribe } from '../events';
import { dayLabel, plural, sameDay } from '../format';
import { Avatar } from './Avatar';
import { MessageBubble } from './MessageBubble';

interface Props {
  conversation: Conversation;
  connector: ConnectorStatus | undefined;
  insightsOpen: boolean;
  onToggleInsights: () => void;
  onBack: () => void;
  onOpenAccounts: () => void;
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

  const add = useCallback((message: Message) => setMessages((list) => insertSorted(list, message)), []);

  return { messages, loading, hasOlder: cursor !== null, loadOlder, add };
}

export function Thread(props: Props) {
  const { conversation, connector, onError } = props;
  const { messages, loading, hasOlder, loadOlder, add } = useMessages(conversation.id, onError);
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const stickToBottom = useRef(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

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

  const readOnlyReason =
    conversation.sourceKind === 'import'
      ? 'Imported conversation — read only'
      : !connector
        ? 'This account is not configured'
        : connector.state !== 'connected'
          ? `${connector.label} is ${connector.state === 'reconnecting' ? 'reconnecting…' : 'not connected'}`
          : null;

  const send = async () => {
    const text = draft.trim();
    if (!text || readOnlyReason || sending) return;
    setSending(true);
    try {
      stickToBottom.current = true;
      add(await api.send(conversation.id, text));
      setDraft('');
    } catch (err) {
      onError(`Not sent: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const subtitle = [
    conversation.platform === 'whatsapp' ? 'WhatsApp' : 'Instagram',
    conversation.isGroup ? plural(conversation.participants.length, 'participant') : null,
    conversation.sourceKind === 'import' ? `imported · ${plural(conversation.messageCount, 'message')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <main className="thread">
      <header className="thread-header">
        <button className="icon-btn back-btn" onClick={props.onBack} aria-label="Back to conversations">
          ‹
        </button>
        <Avatar name={conversation.title} platform={conversation.platform} size={38} />
        <div className="thread-heading">
          <h2>{conversation.title}</h2>
          <p>{subtitle}</p>
        </div>
        <button
          className={`btn btn-quiet ${props.insightsOpen ? 'active' : ''}`}
          onClick={props.onToggleInsights}
          aria-pressed={props.insightsOpen}
        >
          Insights
        </button>
      </header>

      <div className="messages" ref={scroller} onScroll={onScroll}>
        {!loading && hasOlder && <div className="load-more">Loading earlier messages…</div>}
        {!loading && !hasOlder && messages.length > 0 && <div className="load-more">Beginning of conversation</div>}
        {!loading && messages.length === 0 && <div className="load-more">No messages yet</div>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !sameDay(prev.timestamp, m.timestamp);
          const grouped =
            !newDay &&
            prev &&
            prev.senderId === m.senderId &&
            prev.kind !== 'system' &&
            m.timestamp - prev.timestamp < 5 * 60_000;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="day-separator">
                  <span>{dayLabel(m.timestamp)}</span>
                </div>
              )}
              <MessageBubble
                message={m}
                showSender={conversation.isGroup && !m.fromSelf && !grouped}
                grouped={!!grouped}
              />
            </Fragment>
          );
        })}
      </div>

      <footer className="composer">
        {readOnlyReason ? (
          <div className="composer-disabled">
            {readOnlyReason}
            {conversation.sourceKind === 'live' && (
              <button className="btn btn-quiet" onClick={props.onOpenAccounts}>
                Accounts
              </button>
            )}
          </div>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={`Message ${conversation.title}`}
              rows={Math.min(6, Math.max(1, draft.split('\n').length))}
              aria-label="Message"
            />
            <button
              className="btn btn-primary send-btn"
              onClick={() => void send()}
              disabled={!draft.trim() || sending}
            >
              Send
            </button>
          </>
        )}
      </footer>
    </main>
  );
}
