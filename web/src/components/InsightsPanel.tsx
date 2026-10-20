import { useEffect, useState } from 'react';
import { api, type Conversation, type ConversationStats } from '../api';
import { effectiveGroup } from '../../../src/core/groups';
import { subscribe } from '../events';
import { GroupMetricsCard } from './GroupMetricsCard';
import { duration, fullDate, plural } from '../format';

interface Props {
  conversation: Conversation;
  /** Omit when embedded in a view that has its own header. */
  onClose?: () => void;
  onError: (message: string) => void;
  onDeleted: () => void;
  now: number;
}

const RANGES = [
  { label: 'Whole conversation', value: 0 },
  { label: 'Last 200 messages', value: 200 },
  { label: 'Last 1,000 messages', value: 1000 },
  { label: 'Last 5,000 messages', value: 5000 },
];

const SERIES_SLOTS = 8;
const HOURS = ['12am', '6am', '12pm', '6pm'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function InsightsPanel({ conversation, onClose, onError, onDeleted, now }: Props) {
  // Group metrics change when the group does, including on its own (a ghost, a date passing).
  const groupKey = `${effectiveGroup(conversation, now)}:${conversation.dateAt}`;
  const [stats, setStats] = useState<ConversationStats | null>(null);
  const [range, setRange] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api.insights(conversation.id).then(setStats, (err: Error) => onError(err.message));
    void load();
    const unsubscribe = subscribe((event) => {
      const relevant =
        (event.type === 'message.upserted' && event.message.conversationId === conversation.id) ||
        (event.type === 'messages.bulk' && event.conversationId === conversation.id);
      if (!relevant) return;
      clearTimeout(timer);
      timer = setTimeout(load, 1500);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [conversation.id, groupKey, onError]);

  const hasSelf = conversation.participants.some((p) => p.isSelf);
  // Colour follows the person, never their rank: you are always the first colour,
  // everyone else keeps their place in the participant list.
  const order = [
    ...conversation.participants.filter((p) => p.isSelf).map((p) => p.id),
    ...(stats?.participants.filter((p) => p.isSelf).map((p) => p.id) ?? []),
    ...conversation.participants.filter((p) => !p.isSelf).map((p) => p.id),
    ...(stats?.participants.filter((p) => !p.isSelf).map((p) => p.id) ?? []),
  ].filter((id, i, all) => all.indexOf(id) === i);
  const slotOf = (id: string) => {
    const i = order.indexOf(id);
    return i >= 0 && i < SERIES_SLOTS ? i + 1 : null;
  };

  const copyTranscript = async () => {
    try {
      const text = await api.transcript(conversation.id, range || undefined);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onError(`Couldn't copy: ${(err as Error).message}`);
    }
  };

  const deleteImport = async () => {
    if (!confirm(`Delete the imported conversation "${conversation.title}"? You can import it again later.`)) return;
    try {
      await api.deleteConversation(conversation.id);
      onDeleted();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <aside className={`insights ${onClose ? '' : 'insights-embedded'}`} aria-label="Insights">
      {onClose && (
        <header className="insights-header">
          <h2>Insights</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close insights">
            ×
          </button>
        </header>
      )}

      <div className="insights-body">
        {!hasSelf && conversation.participants.length > 1 && (
          <section className="card card-attention">
            <label className="field">
              <span>Which one is you?</span>
              <select
                defaultValue=""
                onChange={(e) =>
                  api.setSelf(conversation.id, e.target.value || null).catch((err: Error) => onError(err.message))
                }
              >
                <option value="" disabled>
                  Choose…
                </option>
                {conversation.participants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              The export doesn't say. This puts your messages on the right and makes the stats about you and them.
            </p>
          </section>
        )}

        {stats && <GroupMetricsCard metrics={stats.groupMetrics} now={now} />}

        {stats && stats.totalMessages > 0 ? (
          <>
            <section className="tiles">
              <Tile label="Messages" value={stats.totalMessages.toLocaleString()} />
              <Tile label="Active days" value={stats.activeDays.toLocaleString()} />
              <Tile
                label="Conversations"
                value={stats.sessions.toLocaleString()}
                hint="Bursts separated by 6+ hours of silence"
              />
              <Tile label="Since" value={stats.firstMessageAt ? fullDate(stats.firstMessageAt) : '—'} />
            </section>

            <section className="card">
              <h3>Who talks</h3>
              <ShareBar stats={stats} slotOf={slotOf} />
              <div className="table-scroll">
                <table className="people">
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col" title="Messages sent">
                        Msgs
                      </th>
                      <th scope="col" title="Average words per message">
                        Words
                      </th>
                      <th scope="col" title="Share of conversations they started">
                        Starts
                      </th>
                      <th scope="col" title="Median time to reply to the other side">
                        Reply
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.participants.map((p) => {
                      const slot = slotOf(p.id);
                      return (
                        <tr key={p.id}>
                          <th scope="row">
                            <span
                              className="swatch"
                              style={{ background: slot ? `var(--series-${slot})` : 'var(--series-other)' }}
                            />
                            {p.name}
                            {p.isSelf && <span className="you"> (you)</span>}
                          </th>
                          <td>{p.messages.toLocaleString()}</td>
                          <td>{p.messages ? (p.words / p.messages).toFixed(1) : '—'}</td>
                          <td>{stats.sessions ? `${Math.round((p.initiations / stats.sessions) * 100)}%` : '—'}</td>
                          <td>{duration(p.medianReplyMs)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card">
              <h3>When you talk</h3>
              <ColumnChart
                label="Messages by hour of day"
                data={stats.byHour.map((count, h) => ({
                  value: count,
                  tooltip: `${new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}: ${plural(count, 'message')}`,
                }))}
                ticks={HOURS.map((label, i) => ({ index: i * 6, label }))}
              />
              <ColumnChart
                label="Messages by day of week"
                data={stats.byWeekday.map((count, d) => ({
                  value: count,
                  tooltip: `${WEEKDAYS[d]}: ${plural(count, 'message')}`,
                }))}
                ticks={WEEKDAYS.map((label, index) => ({ index, label }))}
                height={56}
              />
            </section>

            {stats.byMonth.length > 1 && (
              <section className="card">
                <h3>Over time</h3>
                <ColumnChart
                  label="Messages per month"
                  data={stats.byMonth
                    .slice(-36)
                    .map((m) => ({ value: m.count, tooltip: `${monthLabel(m.month)}: ${plural(m.count, 'message')}` }))}
                  ticks={monthTicks(stats.byMonth.slice(-36).map((m) => m.month))}
                />
              </section>
            )}
          </>
        ) : (
          stats && <p className="hint">No messages to analyse yet.</p>
        )}

        <section className="card">
          <h3>Context for an AI</h3>
          <p className="hint">The transcript you'd otherwise export by hand, ready to paste into a model.</p>
          <label className="field">
            <span>Range</span>
            <select value={range} onChange={(e) => setRange(Number(e.target.value))}>
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button className="btn" onClick={() => void copyTranscript()}>
              {copied ? 'Copied' : 'Copy transcript'}
            </button>
            <a className="btn btn-quiet" href={api.transcriptUrl(conversation.id, range || undefined)}>
              Download .txt
            </a>
          </div>
          <p className="coming-next">
            Next: ask questions about this conversation right here — summaries, tone, translation.
          </p>
        </section>

        {conversation.sourceKind === 'import' && (
          <button className="btn btn-danger-quiet" onClick={() => void deleteImport()}>
            Delete imported conversation
          </button>
        )}
      </div>
    </aside>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="tile" title={hint}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function ShareBar({ stats, slotOf }: { stats: ConversationStats; slotOf: (id: string) => number | null }) {
  const total = stats.totalMessages;
  return (
    <div
      className="share"
      role="img"
      aria-label={stats.participants.map((p) => `${p.name} ${Math.round((p.messages / total) * 100)}%`).join(', ')}
    >
      <div className="share-bar">
        {stats.participants.map((p) => {
          const slot = slotOf(p.id);
          return (
            <span
              key={p.id}
              className="share-segment"
              style={{ flexGrow: p.messages, background: slot ? `var(--series-${slot})` : 'var(--series-other)' }}
              title={`${p.name}: ${plural(p.messages, 'message')} (${Math.round((p.messages / total) * 100)}%)`}
            />
          );
        })}
      </div>
      <div className="share-legend">
        {stats.participants.slice(0, 4).map((p) => {
          const slot = slotOf(p.id);
          return (
            <span key={p.id}>
              <span className="swatch" style={{ background: slot ? `var(--series-${slot})` : 'var(--series-other)' }} />
              {p.name} <strong>{Math.round((p.messages / total) * 100)}%</strong>
            </span>
          );
        })}
      </div>
    </div>
  );
}

interface Column {
  value: number;
  tooltip: string;
}

function ColumnChart({
  label,
  data,
  ticks,
  height = 72,
}: {
  label: string;
  data: Column[];
  ticks: { index: number; label: string }[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <figure className="columns" aria-label={label}>
      <figcaption className="sr-only">{label}</figcaption>
      <div className="columns-plot" style={{ height }} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <div
            key={i}
            className={`column-slot ${hover === i ? 'hover' : ''}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            tabIndex={0}
            aria-label={d.tooltip}
          >
            <span className="column" style={{ height: d.value ? `max(2px, ${(d.value / max) * 100}%)` : 0 }} />
          </div>
        ))}
        {hover !== null && data[hover] && (
          <div className="chart-tooltip" style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}>
            {data[hover].tooltip}
          </div>
        )}
      </div>
      <div className="columns-axis" aria-hidden="true">
        {ticks.map((t) => {
          // Labels on the first and last column hug the edges so they never spill out of the card.
          const edge = t.index === 0 ? 'tick-start' : t.index === data.length - 1 ? 'tick-end' : '';
          return (
            <span key={t.index} className={edge} style={{ left: `${((t.index + 0.5) / data.length) * 100}%` }}>
              {t.label}
            </span>
          );
        })}
      </div>
    </figure>
  );
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function monthTicks(months: string[]): { index: number; label: string }[] {
  if (months.length === 0) return [];
  const short = (m: string) => {
    const [y, mo] = m.split('-').map(Number);
    return new Date(y!, mo! - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  };
  const last = months.length - 1;
  return last === 0
    ? [{ index: 0, label: short(months[0]!) }]
    : [
        { index: 0, label: short(months[0]!) },
        { index: last, label: short(months[last]!) },
      ];
}
