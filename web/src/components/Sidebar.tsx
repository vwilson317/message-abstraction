import { useMemo, useState } from 'react';
import type { Conversation, ConnectorStatus, GroupId, Platform, Settings } from '../api';
import { effectiveGroup, GROUPS } from '../../../src/core/groups';
import { dateTime, listTime, sinceLabel } from '../format';
import { useLongPress } from '../useLongPress';
import { Avatar } from './Avatar';

type PlatformFilter = 'all' | Platform;

interface Props {
  conversations: Conversation[];
  connectors: ConnectorStatus[];
  settings: Settings;
  now: number;
  loaded: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (conversation: Conversation, at: { x: number; y: number }) => void;
  onToggleAlerts: (group: GroupId) => void;
  onOpenSources: () => void;
}

function readTab(): GroupId {
  try {
    const saved = localStorage.getItem('inbox.group');
    return GROUPS.some((g) => g.id === saved) ? (saved as GroupId) : 'close';
  } catch {
    return 'close';
  }
}

function writeTab(group: GroupId): void {
  try {
    localStorage.setItem('inbox.group', group);
  } catch {
    // The tab just won't be remembered.
  }
}

export function Sidebar(props: Props) {
  const [tab, setTab] = useState<GroupId>(readTab);
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const [query, setQuery] = useState('');
  const { now, settings } = props;

  const grouped = useMemo(
    () => props.conversations.map((c) => ({ c, group: effectiveGroup(c, now) })),
    [props.conversations, now],
  );

  const q = query.trim().toLowerCase();
  const visible = grouped.filter(
    ({ c, group }) =>
      // Searching looks across every group.
      (q ? c.title.toLowerCase().includes(q) || !!c.lastMessagePreview?.toLowerCase().includes(q) : group === tab) &&
      (platform === 'all' || c.platform === platform),
  );
  // Dates sort by when they happen; everything else by latest message.
  if (tab === 'dates' && !q) visible.sort((a, b) => (a.c.dateAt ?? 0) - (b.c.dateAt ?? 0));

  const countIn = (group: GroupId) => grouped.filter((g) => g.group === group).length;
  const unreadIn = (group: GroupId) =>
    settings.groupAlerts[group] ? grouped.filter((g) => g.group === group && g.c.unreadCount > 0).length : 0;
  const tabInfo = GROUPS.find((g) => g.id === tab)!;
  const alertsOn = settings.groupAlerts[tab];

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
        <div className="search-row">
          <input
            className="search"
            type="search"
            placeholder="Search everyone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search conversations"
          />
          <select
            className="platform-select"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as PlatformFilter)}
            aria-label="App"
          >
            <option value="all">All apps</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="instagram">Instagram</option>
          </select>
        </div>
        <div className="group-tabs" role="tablist" aria-label="Groups">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={tab === g.id && !q}
              className={`group-tab group-${g.id} ${tab === g.id && !q ? 'active' : ''}`}
              onClick={() => {
                setTab(g.id);
                writeTab(g.id);
                setQuery('');
              }}
              title={`${g.label}: ${g.description}`}
            >
              {g.short}
              <span className="group-count">{countIn(g.id)}</span>
              {unreadIn(g.id) > 0 && <span className="group-unread" aria-label={`${unreadIn(g.id)} unread`} />}
            </button>
          ))}
        </div>
        {!q && (
          <div className="group-bar">
            <span>{tabInfo.description}</span>
            <button
              className={`icon-btn bell ${alertsOn ? 'on' : ''}`}
              onClick={() => props.onToggleAlerts(tab)}
              aria-pressed={alertsOn}
              title={alertsOn ? `Alerts on for ${tabInfo.label}` : `Alerts off for ${tabInfo.label}`}
            >
              {alertsOn ? '🔔' : '🔕'}
            </button>
          </div>
        )}
      </div>

      <nav className="conversation-list" aria-label="Conversations">
        {props.loaded && visible.length === 0 && (
          <p className="list-empty">
            {q ? 'Nothing matches.' : props.conversations.length === 0 ? 'No conversations yet.' : emptyHint(tab)}
          </p>
        )}
        {visible.map(({ c, group }) => (
          <ConversationRow
            key={c.id}
            conversation={c}
            group={group}
            muted={!settings.groupAlerts[group]}
            showGroup={!!q}
            now={now}
            selected={c.id === props.selectedId}
            onSelect={() => props.onSelect(c.id)}
            onMove={(at) => props.onMove(c, at)}
          />
        ))}
      </nav>
      {!q && visible.length > 0 && <p className="long-press-hint">Press and hold a conversation to move it.</p>}
    </aside>
  );
}

function emptyHint(group: GroupId): string {
  switch (group) {
    case 'close':
      return 'No one here. Conversations land here unless you move them.';
    case 'romantic':
      return 'Press and hold a conversation to move it here.';
    case 'dates':
      return 'Schedule a date from a conversation’s menu (press and hold).';
    case 'ghosts':
      return 'Nobody’s gone quiet. Romantic interests land here after 48 hours of silence.';
  }
}

interface RowProps {
  conversation: Conversation;
  group: GroupId;
  muted: boolean;
  showGroup: boolean;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onMove: (at: { x: number; y: number }) => void;
}

function ConversationRow({ conversation: c, group, muted, showGroup, now, selected, onSelect, onMove }: RowProps) {
  const press = useLongPress(onMove);
  const unread = !muted && c.unreadCount > 0;
  let note: string | null = null;
  if (group === 'dates' && c.dateAt !== null) note = dateTime(c.dateAt);
  else if (group === 'ghosts') note = `Silent ${sinceLabel(c.lastMessageAt, now)}`;
  else if (showGroup) note = GROUPS.find((g) => g.id === group)!.short;

  return (
    <button
      className={`conversation ${selected ? 'selected' : ''} ${unread ? 'unread' : ''}`}
      onClick={onSelect}
      {...press}
      onKeyDown={(e) => {
        // Shift+F10 / the menu key, for keyboards.
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          onMove({ x: rect.left + 24, y: rect.bottom });
        }
      }}
    >
      <Avatar name={c.title} platform={c.platform} />
      <span className="conversation-body">
        <span className="conversation-top">
          <span className="conversation-title">{c.title}</span>
          <span className="conversation-time">{listTime(c.lastMessageAt)}</span>
        </span>
        <span className="conversation-bottom">
          <span className="conversation-preview">{c.lastMessagePreview ?? ''}</span>
          {note && <span className={`tag tag-${group}`}>{note}</span>}
          {c.sourceKind === 'import' && <span className="tag">Imported</span>}
          {unread && <span className="badge">{c.unreadCount}</span>}
        </span>
      </span>
    </button>
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
