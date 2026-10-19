import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Conversation, type ConnectorStatus } from './api';
import { AccountsDialog } from './components/AccountsDialog';
import { ImportDialog } from './components/ImportDialog';
import { InsightsPanel } from './components/InsightsPanel';
import { Sidebar } from './components/Sidebar';
import { Thread } from './components/Thread';
import { Toasts, useToasts } from './components/Toasts';
import { subscribe } from './events';

type Dialog = 'accounts' | 'import' | null;

function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => (b.lastMessageAt ?? -Infinity) - (a.lastMessageAt ?? -Infinity));
}

function readHash(): string | null {
  const id = decodeURIComponent(window.location.hash.slice(1));
  return id || null;
}

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(readHash);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showInsights, setShowInsights] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  const toasts = useToasts();
  const showError = toasts.error;

  const refresh = useCallback(async () => {
    try {
      const [convs, conns] = await Promise.all([api.conversations(), api.connectors()]);
      setConversations(sortConversations(convs));
      setConnectors(conns);
    } catch (err) {
      showError(`Couldn't reach the server: ${(err as Error).message}`);
    } finally {
      setLoaded(true);
    }
  }, [showError]);

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
          setSelectedId((id) => (id === event.conversationId ? null : id));
          break;
        case 'connector.status':
          setConnectors((list) => list.map((c) => (c.id === event.status.id ? event.status : c)));
          break;
      }
    });
  }, [refresh]);

  // Keep the open conversation in the URL so a reload lands in the same place.
  useEffect(() => {
    const hash = selectedId ? `#${encodeURIComponent(selectedId)}` : '';
    if (window.location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  }, [selectedId]);

  const selected = useMemo(() => conversations.find((c) => c.id === selectedId) ?? null, [conversations, selectedId]);
  const connector = selected ? connectors.find((c) => c.id === selected.sourceId) : undefined;

  return (
    <div className={`app ${selected ? 'has-selection' : ''} ${showInsights && selected ? 'with-insights' : ''}`}>
      <Sidebar
        conversations={conversations}
        connectors={connectors}
        loaded={loaded}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenAccounts={() => setDialog('accounts')}
        onOpenImport={() => setDialog('import')}
      />

      {selected ? (
        <Thread
          key={`thread:${selected.id}`}
          conversation={selected}
          connector={connector}
          insightsOpen={showInsights}
          onToggleInsights={() => setShowInsights((v) => !v)}
          onBack={() => setSelectedId(null)}
          onOpenAccounts={() => setDialog('accounts')}
          onError={showError}
        />
      ) : (
        <main className="thread thread-empty">
          <Welcome
            hasConversations={conversations.length > 0}
            onConnect={() => setDialog('accounts')}
            onImport={() => setDialog('import')}
          />
        </main>
      )}

      {selected && showInsights && (
        <InsightsPanel
          key={`insights:${selected.id}`}
          conversation={selected}
          onClose={() => setShowInsights(false)}
          onError={showError}
          onDeleted={() => setSelectedId(null)}
        />
      )}

      {dialog === 'accounts' && (
        <AccountsDialog
          connectors={connectors}
          onClose={() => setDialog(null)}
          onImport={() => setDialog('import')}
          onError={showError}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          onClose={() => setDialog(null)}
          onOpen={(id) => {
            setSelectedId(id);
            setDialog(null);
          }}
        />
      )}
      <Toasts items={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );
}

function Welcome(props: { hasConversations: boolean; onConnect: () => void; onImport: () => void }) {
  if (props.hasConversations) {
    return (
      <div className="welcome">
        <p className="welcome-hint">Pick a conversation to start.</p>
      </div>
    );
  }
  return (
    <div className="welcome">
      <h1>One inbox for WhatsApp and Instagram</h1>
      <p>
        Link WhatsApp to read and reply live, or import chat exports from either app. Everything stays on this machine.
      </p>
      <div className="welcome-actions">
        <button className="btn btn-primary" onClick={props.onConnect}>
          Connect WhatsApp
        </button>
        <button className="btn" onClick={props.onImport}>
          Import an export
        </button>
      </div>
    </div>
  );
}
