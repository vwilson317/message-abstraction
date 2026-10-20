import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation } from './api';
import { Avatar } from './components/Avatar';
import { InsightsPanel } from './components/InsightsPanel';
import { Thread } from './components/Thread';
import { Toasts, useToasts } from './components/Toasts';
import { subscribe } from './events';
import { listTime } from './format';
import { useInbox } from './useInbox';

/**
 * A narrow view that sits beside a messaging app and shows the conversation
 * you're in. Two ways it learns which one that is:
 *
 * - Inside the Chrome extension's side panel, the extension tells it which
 *   Instagram thread the active tab has open.
 * - On its own (next to WhatsApp Desktop), it follows the chat you last sent
 *   a message in, until you pick one yourself.
 *
 * Chrome can float it above every other app with Document Picture-in-Picture.
 */

type Tab = 'insights' | 'chat';

interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

const pip = (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
const embedded = new URLSearchParams(location.search).get('embed') === 'extension';

function readFollow(): boolean {
  try {
    return localStorage.getItem('companion.follow') !== 'off';
  } catch {
    return true;
  }
}

function writeFollow(on: boolean): void {
  try {
    localStorage.setItem('companion.follow', on ? 'on' : 'off');
  } catch {
    // Private mode or blocked storage: the setting just won't stick.
  }
}

export function Companion() {
  const toasts = useToasts();
  const showError = toasts.error;
  const { conversations, connectors, loaded } = useInbox(showError);
  const [focusedId, setFocusedId] = useState<string | null>(() => decodeURIComponent(location.hash.slice(1)) || null);
  const [follow, setFollow] = useState(() => !embedded && readFollow());
  const [tab, setTab] = useState<Tab>('insights');
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [extensionThread, setExtensionThread] = useState<string | null | undefined>(undefined);
  const [historyRead, setHistoryRead] = useState<{ steps: number; done: boolean; reason: string } | null>(null);
  const [diagnosis, setDiagnosis] = useState<Record<string, unknown> | null>(null);
  const toExtension = (message: object) => window.parent.postMessage(message, '*');

  // In the side panel, the extension drives focus and reports on reader actions.
  useEffect(() => {
    if (!embedded) return;
    const onMessage = (event: MessageEvent) => {
      if (!event.origin.startsWith('chrome-extension://')) return;
      const data = event.data as Record<string, unknown> | null;
      if (data?.type === 'focus') {
        const id = typeof data.conversationId === 'string' ? data.conversationId : null;
        setExtensionThread(id);
        if (id) setFocusedId(id);
      } else if (data?.type === 'history-progress') {
        setHistoryRead({ steps: Number(data.steps), done: data.done === true, reason: String(data.reason ?? '') });
      } else if (data?.type === 'diagnosis') {
        setDiagnosis(data.diagnosis as Record<string, unknown>);
      } else if (data?.type === 'extension-error') {
        showError(String(data.error));
      }
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'ready' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [showError]);

  // On its own, follow the chat you're replying in.
  useEffect(() => {
    if (embedded || !follow) return;
    return subscribe((event) => {
      if (
        event.type === 'message.upserted' &&
        event.message.fromSelf &&
        !event.message.conversationId.startsWith('import:')
      ) {
        setFocusedId(event.message.conversationId);
      }
    });
  }, [follow]);

  // With nothing chosen yet, start from the most recently active live conversation.
  useEffect(() => {
    if (embedded || focusedId || !loaded) return;
    const latest = conversations.find((c) => c.sourceKind === 'live') ?? conversations[0];
    if (latest) setFocusedId(latest.id);
  }, [loaded, conversations, focusedId]);

  useEffect(() => {
    const hash = focusedId ? `#${encodeURIComponent(focusedId)}` : '';
    if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  }, [focusedId]);

  const focused = useMemo(() => conversations.find((c) => c.id === focusedId) ?? null, [conversations, focusedId]);
  const choices = useMemo(() => conversations.slice(0, 200), [conversations]);

  const choose = (id: string) => {
    setFocusedId(id);
    if (follow) {
      setFollow(false);
      writeFollow(false);
    }
  };

  const popOut = async () => {
    if (!pip) return;
    try {
      const win = await pip.requestWindow({ width: 400, height: 720 });
      for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
        win.document.head.appendChild(node.cloneNode(true));
      }
      win.document.title = 'Inbox';
      win.document.body.classList.add('pip-body');
      win.addEventListener('pagehide', () => setPipWindow(null));
      setPipWindow(win);
    } catch (err) {
      showError(`Couldn't float the panel: ${(err as Error).message}`);
    }
  };

  let body: ReactNode;
  if (focused) {
    body =
      tab === 'insights' ? (
        <InsightsPanel
          key={`insights:${focused.id}`}
          conversation={focused}
          onError={showError}
          onDeleted={() => setFocusedId(null)}
        />
      ) : (
        <Thread
          key={`thread:${focused.id}`}
          conversation={focused}
          connector={connectors.find((c) => c.id === focused.sourceId)}
          onOpenSources={() => window.open('/', '_blank')}
          onError={showError}
        />
      );
  } else {
    body = <EmptyState loaded={loaded} extensionThread={extensionThread} hasConversations={conversations.length > 0} />;
  }

  const view = (
    <div className="companion">
      <header className="companion-header">
        {focused ? <Avatar name={focused.title} platform={focused.platform} size={34} /> : null}
        <select
          className="companion-picker"
          value={focusedId ?? ''}
          onChange={(e) => choose(e.target.value)}
          aria-label="Conversation"
          disabled={embedded}
        >
          {!focused && <option value="">{embedded ? 'Instagram' : 'Choose a conversation'}</option>}
          {choices.map((c: Conversation) => (
            <option key={c.id} value={c.id}>
              {c.title} · {c.platform === 'whatsapp' ? 'WhatsApp' : 'Instagram'}
              {c.sourceKind === 'import' ? ' (imported)' : ''} · {listTime(c.lastMessageAt)}
            </option>
          ))}
        </select>
        {!embedded && (
          <button
            className={`btn btn-quiet ${follow ? 'active' : ''}`}
            aria-pressed={follow}
            title="Switch to whichever chat you send a message in"
            onClick={() => {
              setFollow(!follow);
              writeFollow(!follow);
            }}
          >
            Follow
          </button>
        )}
        {!embedded && pip && !pipWindow && (
          <button className="btn btn-quiet" title="Float this panel above other apps" onClick={() => void popOut()}>
            Float
          </button>
        )}
      </header>
      {focused && (
        <nav className="companion-tabs" role="tablist">
          {(['insights', 'chat'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`filter ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'insights' ? 'Insights' : 'Messages'}
            </button>
          ))}
          <a className="companion-open" href={`/#${encodeURIComponent(focused.id)}`} target="_blank" rel="noopener">
            Open in Inbox ↗
          </a>
        </nav>
      )}
      <div className="companion-body">{body}</div>
      {embedded && (
        <footer className="companion-footer">
          {historyRead && !historyRead.done ? (
            <>
              <span>Reading earlier messages… step {historyRead.steps}</span>
              <button className="btn btn-quiet" onClick={() => toExtension({ type: 'stop-history' })}>
                Stop
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-quiet"
                title="Scrolls this Instagram conversation back slowly so older messages load and get read. Instagram sees ordinary scrolling."
                disabled={!extensionThread}
                onClick={() => {
                  setHistoryRead({ steps: 0, done: false, reason: '' });
                  toExtension({ type: 'read-history', maxSteps: 40 });
                }}
              >
                Read earlier messages
              </button>
              {historyRead?.done && <span className="companion-note">{historyRead.reason}</span>}
            </>
          )}
          <button className="btn btn-quiet" onClick={() => toExtension({ type: 'diagnose' })}>
            Check reader
          </button>
          {diagnosis && (
            <pre className="companion-diagnosis" onClick={() => setDiagnosis(null)} title="Click to close">
              {JSON.stringify(diagnosis, null, 2)}
            </pre>
          )}
        </footer>
      )}
      <Toasts items={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );

  if (pipWindow) {
    return (
      <>
        {createPortal(view, pipWindow.document.body)}
        <div className="companion companion-floating">
          <p>The panel is floating above your other apps. Close the floating window to bring it back here.</p>
        </div>
      </>
    );
  }
  return view;
}

function EmptyState(props: { loaded: boolean; extensionThread: string | null | undefined; hasConversations: boolean }) {
  if (!props.loaded) return <p className="companion-empty">Loading…</p>;
  if (embedded) {
    return (
      <p className="companion-empty">
        {props.extensionThread
          ? 'Reading this conversation…'
          : 'Open a conversation on instagram.com/direct and its insights show up here.'}
      </p>
    );
  }
  return (
    <p className="companion-empty">
      {props.hasConversations
        ? 'Pick a conversation, or send a message in WhatsApp and this panel follows you there.'
        : 'Nothing yet. Start the server on the Mac where WhatsApp Desktop is signed in, or open Instagram with the extension.'}
    </p>
  );
}
