import { Fragment, memo, useState, type ReactNode } from 'react';
import type { Attachment, Message } from '../api';
import { hueFor, timeOfDay } from '../format';

const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;

function linkify(text: string): ReactNode[] {
  return text.split(URL_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

const ATTACHMENT_LABEL: Record<Attachment['type'], string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Voice message',
  sticker: 'Sticker',
  document: 'Document',
  location: 'Location',
  contact: 'Contact',
  link: 'Link',
  other: 'Attachment',
};

const ATTACHMENT_ICON: Record<Attachment['type'], string> = {
  image: '📷',
  video: '🎥',
  audio: '🎤',
  sticker: '💟',
  document: '📄',
  location: '📍',
  contact: '👤',
  link: '🔗',
  other: '📎',
};

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const { type, name } = attachment;
  // Links to Instagram's CDN expire; fall back to the chip when an image won't load.
  const [broken, setBroken] = useState(false);
  const url = broken ? undefined : attachment.url;
  if (url && (type === 'image' || type === 'sticker')) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={`media media-${type}`}>
        <img
          src={url}
          alt={name ?? ATTACHMENT_LABEL[type]}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      </a>
    );
  }
  if (url && type === 'video') return <video className="media media-video" src={url} controls preload="metadata" />;
  if (url && type === 'audio') return <audio className="media-audio" src={url} controls preload="none" />;
  const label = name ?? ATTACHMENT_LABEL[type];
  const chip = (
    <>
      <span aria-hidden="true">{ATTACHMENT_ICON[type]}</span>
      <span className="chip-label">{label}</span>
      {!url && type !== 'link' && type !== 'location' && <span className="chip-note">not included</span>}
    </>
  );
  return url ? (
    <a className="attachment-chip" href={url} target="_blank" rel="noopener noreferrer">
      {chip}
    </a>
  ) : (
    <span className="attachment-chip">{chip}</span>
  );
}

function StatusTicks({ status }: { status: Message['status'] }) {
  if (!status) return null;
  const label = { pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' }[status];
  const glyph = { pending: '◷', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' }[status];
  return (
    <span className={`ticks ticks-${status}`} title={label} aria-label={label}>
      {glyph}
    </span>
  );
}

interface Props {
  message: Message;
  showSender: boolean;
  grouped: boolean;
}

export const MessageBubble = memo(function MessageBubble({ message: m, showSender, grouped }: Props) {
  if (m.kind === 'system') {
    return (
      <div className="system-message">
        <span>
          {m.senderName ? `${m.senderName}: ` : ''}
          {m.text}
        </span>
      </div>
    );
  }

  const side = m.fromSelf ? 'out' : 'in';
  return (
    <div className={`row row-${side} ${grouped ? 'grouped' : ''}`}>
      <div className={`bubble bubble-${side} ${m.deleted ? 'deleted' : ''}`}>
        {showSender && (
          <div className="sender" style={{ ['--sender-hue' as string]: hueFor(m.senderName) }}>
            {m.senderName}
          </div>
        )}
        {m.deleted ? (
          <div className="text deleted-text">This message was deleted</div>
        ) : (
          <>
            {m.attachments.map((a, i) => (
              <AttachmentView key={i} attachment={a} />
            ))}
            {m.text && <div className="text">{linkify(m.text)}</div>}
          </>
        )}
        <div className="meta">
          {m.edited && <span className="edited">edited</span>}
          <time dateTime={new Date(m.timestamp).toISOString()} title={new Date(m.timestamp).toLocaleString()}>
            {timeOfDay(m.timestamp)}
          </time>
          {m.fromSelf && <StatusTicks status={m.status} />}
        </div>
      </div>
      {m.reactions.length > 0 && (
        <div className="reactions" title={m.reactions.map((r) => `${r.emoji} ${r.senderName}`).join('\n')}>
          {m.reactions.map((r, i) => (
            <span key={i}>{r.emoji}</span>
          ))}
        </div>
      )}
    </div>
  );
});
