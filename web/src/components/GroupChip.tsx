import type { Conversation } from '../api';
import { effectiveGroup, GROUPS } from '../../../src/core/groups';
import { untilLabel } from '../format';

const ICON = { close: '🫶', romantic: '💘', dates: '📅', ghosts: '👻' } as const;

/** Shows which group a conversation is in; tap to move it. */
export function GroupChip(props: {
  conversation: Conversation;
  now: number;
  onMove: (at: { x: number; y: number }) => void;
}) {
  const group = effectiveGroup(props.conversation, props.now);
  const label = GROUPS.find((g) => g.id === group)!.short;
  const detail =
    group === 'dates' && props.conversation.dateAt !== null
      ? ` · ${untilLabel(props.conversation.dateAt, props.now)}`
      : '';
  return (
    <button
      className={`group-chip group-${group}`}
      title="Move to another group"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        props.onMove({ x: rect.left, y: rect.bottom + 4 });
      }}
    >
      <span aria-hidden="true">{ICON[group]}</span> {label}
      {detail}
    </button>
  );
}
