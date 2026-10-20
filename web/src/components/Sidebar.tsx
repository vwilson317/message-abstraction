import { useMemo, useState } from 'react';
import type { Conversation, ConnectorStatus, Platform } from '../api';
import { listTime } from '../format';
import { Avatar } from './Avatar';

type Filter = 'all' | Platform;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'instagram', label: 'Instagram' },
];

interface Props {
  conversations: Conversation[];
  connectors: ConnectorStatus[];
  loaded: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSources: () => void;
}

export function Sidebar(props: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.conversations.filter(
      (c) =>
        (filter === 'all' || c.platform === filter) &&
        (!q || c.title.toLowerCase().includes(q) || c.lastMessagePreview?.toLowerCase().includes(q)),
    );
  }, [props.conversations, filter, query]);

  const unread = (platform: Filter) =>
    props.conversations.filter((c) => (platform === 'all' || c.platform === platform) && c.unreadCount > 0).length;

  // Idle sources (Instagram not open right now) are normal; only errors need attention.
  const attention = props.connectors.some((c) => c.state === 'error');

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1 className="brand">Inbox</h1>
        <div className="sidebar-actions">
          <button
            className="btn btn-quiet"
            title="Open a narrow panel to keep beside WhatsApp Desktop"
            onClick={() => window.open('/?view=companion', 'inbox-companion', 'popup,width=420,height=780')}
          >
            Companion
          </button>
          <button
            className="btn btn-quiet accounts-btn"
            onClick={props.onOpenSources}
            title="Where conversations come from"
          >
            <ConnectorDots connectors={props.connectors} />
            Sources
            {attention && <span className="dot-alert" aria-label="Needs attention" />}
          </button>
        </div>
      </header>

      <div className="sidebar-tools">
        <input
          className="search"
          type="search"
          placeholder="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search conversations"
        />
        <div className="filters" role="tablist" aria-label="Filter by app">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={`filter ${filter === f.id ? 'active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {unread(f.id) > 0 && <span className="filter-count">{unread(f.id)}</span>}
            </button>
          ))}
        </div>
      </div>

      <nav className="conversation-list" aria-label="Conversations">
        {props.loaded && visible.length === 0 && (
          <p className="list-empty">
            {props.conversations.length === 0 ? 'No conversations yet.' : 'Nothing matches.'}
          </p>
        )}
        {visible.map((c) => (
          <button
            key={c.id}
            className={`conversation ${c.id === props.selectedId ? 'selected' : ''} ${c.unreadCount ? 'unread' : ''}`}
            onClick={() => props.onSelect(c.id)}
          >
            <Avatar name={c.title} platform={c.platform} />
            <span className="conversation-body">
              <span className="conversation-top">
                <span className="conversation-title">{c.title}</span>
                <span className="conversation-time">{listTime(c.lastMessageAt)}</span>
              </span>
              <span className="conversation-bottom">
                <span className="conversation-preview">{c.lastMessagePreview ?? ''}</span>
                {c.sourceKind === 'import' && <span className="tag">Imported</span>}
                {c.unreadCount > 0 && <span className="badge">{c.unreadCount}</span>}
              </span>
            </span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function ConnectorDots({ connectors }: { connectors: ConnectorStatus[] }) {
  return (
    <span className="connector-dots" aria-hidden="true">
      {connectors.map((c) => (
        <span key={c.id} className={`state-dot state-${c.state}`} />
      ))}
    </span>
  );
}
