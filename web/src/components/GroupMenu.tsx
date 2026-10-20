import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type Conversation, type GroupChange, type GroupId } from '../api';
import { effectiveGroup, GROUPS } from '../../../src/core/groups';
import { dateTime, sinceLabel } from '../format';

interface Props {
  conversation: Conversation;
  /** Where the press happened; the menu opens next to it (or as a sheet on phones). */
  at: { x: number; y: number };
  now: number;
  onClose: () => void;
  onError: (message: string) => void;
}

const ICON: Record<GroupId, string> = { close: '🫶', romantic: '💘', dates: '📅', ghosts: '👻' };

/** `<input type="datetime-local">` speaks local wall-clock time without a zone. */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A first guess for a new date: the next Friday at 8 PM that's at least a few hours away. */
function suggestedDate(now: number): number {
  const d = new Date(now);
  for (let i = 0; ; i++) {
    const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, 20, 0).getTime();
    if (new Date(candidate).getDay() === 5 && candidate > now + 3 * 60 * 60 * 1000) return candidate;
  }
}

export function GroupMenu({ conversation, at, now, onClose, onError }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const current = effectiveGroup(conversation, now);
  const [picking, setPicking] = useState(current === 'dates');
  const [when, setWhen] = useState(() => toLocalInput(conversation.dateAt ?? suggestedDate(now)));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Keep the popover on screen.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || window.matchMedia('(max-width: 799px)').matches) return;
    const rect = dialog.getBoundingClientRect();
    dialog.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - rect.width - 8))}px`;
    dialog.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - rect.height - 8))}px`;
  }, [at, picking]);

  const move = async (change: GroupChange) => {
    setBusy(true);
    try {
      await api.setGroup(conversation.id, change);
      onClose();
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  };

  const schedule = () => {
    const dateAt = new Date(when).getTime();
    if (!Number.isFinite(dateAt)) return onError('Pick a day and time for the date');
    void move({ group: 'dates', dateAt });
  };

  const automatic =
    current === 'ghosts' && conversation.group !== 'ghosts'
      ? `In Ghosts on its own: ${sinceLabel(conversation.lastMessageAt, now)} without a message.`
      : current === 'dates' && conversation.dateAt !== null
        ? `Date: ${dateTime(conversation.dateAt)}.`
        : null;

  return (
    <dialog
      ref={ref}
      className="group-menu"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={`Move ${conversation.title}`}
    >
      <header className="group-menu-header">
        <strong>{conversation.title}</strong>
        <span>Move to…</span>
      </header>
      <ul role="menu">
        {GROUPS.map((g) => (
          <li key={g.id} role="none">
            <button
              role="menuitemradio"
              aria-checked={current === g.id}
              className={`group-option ${current === g.id ? 'current' : ''}`}
              disabled={busy}
              onClick={() => (g.id === 'dates' ? setPicking(true) : void move({ group: g.id }))}
            >
              <span className="group-icon" aria-hidden="true">
                {ICON[g.id]}
              </span>
              <span className="group-text">
                <span>
                  {g.id === 'dates'
                    ? conversation.dateAt && current === 'dates'
                      ? 'Date'
                      : 'Schedule a date…'
                    : g.label}
                </span>
                <small>
                  {g.id === 'ghosts'
                    ? 'Until one of you writes again'
                    : g.id === 'dates'
                      ? 'Pick a day and time'
                      : g.description}
                </small>
              </span>
              {current === g.id && <span aria-hidden="true">✓</span>}
            </button>
            {g.id === 'dates' && picking && (
              <div className="date-picker">
                <input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  aria-label="Date and time"
                  autoFocus
                />
                <button className="btn btn-primary" disabled={busy || !when} onClick={schedule}>
                  {current === 'dates' ? 'Update' : 'Schedule'}
                </button>
                {current === 'dates' && (
                  <button className="btn btn-quiet" disabled={busy} onClick={() => void move({ group: 'romantic' })}>
                    Cancel date
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {automatic && <p className="group-menu-note">{automatic}</p>}
    </dialog>
  );
}
