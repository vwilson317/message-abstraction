import { useEffect, useMemo, useState } from 'react';
import { SourcesDialog } from './components/SourcesDialog';
import { ImportDialog } from './components/ImportDialog';
import { InsightsPanel } from './components/InsightsPanel';
import { Sidebar } from './components/Sidebar';
import { Thread } from './components/Thread';
import { Toasts, useToasts } from './components/Toasts';
import { useInbox } from './useInbox';

type Dialog = 'sources' | 'import' | null;

function readHash(): string | null {
  const id = decodeURIComponent(window.location.hash.slice(1));
  return id || null;
}

export function App() {
  const [selectedId, setSelectedId] = useState<string | null>(readHash);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showInsights, setShowInsights] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  const toasts = useToasts();
  const showError = toasts.error;
  const { conversations, connectors, loaded } = useInbox(showError, (id) =>
    setSelectedId((current) => (current === id ? null : current)),
  );

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
        onOpenSources={() => setDialog('sources')}
      />

      {selected ? (
        <Thread
          key={`thread:${selected.id}`}
          conversation={selected}
          connector={connector}
          header={{
            insightsOpen: showInsights,
            onToggleInsights: () => setShowInsights((v) => !v),
            onBack: () => setSelectedId(null),
          }}
          onOpenSources={() => setDialog('sources')}
          onError={showError}
        />
      ) : (
        <main className="thread thread-empty">
          <Welcome
            hasConversations={conversations.length > 0}
            onSources={() => setDialog('sources')}
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

      {dialog === 'sources' && (
        <SourcesDialog
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

function Welcome(props: { hasConversations: boolean; onSources: () => void; onImport: () => void }) {
  if (props.hasConversations) {
    return (
      <div className="welcome">
        <p className="welcome-hint">Pick a conversation to start.</p>
      </div>
    );
  }
  return (
    <div className="welcome">
      <h1>Insights beside the chats you already have open</h1>
      <p>
        Inbox reads WhatsApp Desktop on your Mac and Instagram in Chrome, read-only, and keeps everything on this
        computer. You keep chatting in the apps.
      </p>
      <div className="welcome-actions">
        <button className="btn btn-primary" onClick={props.onSources}>
          Set up sources
        </button>
        <button className="btn" onClick={props.onImport}>
          Import an export
        </button>
      </div>
    </div>
  );
}
