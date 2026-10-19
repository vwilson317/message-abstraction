import type { Platform } from '../api';
import { hueFor, initials } from '../format';

export function PlatformMark({ platform, size = 16 }: { platform: Platform; size?: number }) {
  return (
    <span
      className={`platform-mark platform-${platform}`}
      style={{ width: size, height: size }}
      title={platform === 'whatsapp' ? 'WhatsApp' : 'Instagram'}
    >
      {platform === 'whatsapp' ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3Zm0 16.4a7.4 7.4 0 0 1-3.8-1l-.3-.2-2.7.7.7-2.6-.2-.3A7.4 7.4 0 1 1 12 19.4Zm4-5.5c-.2-.1-1.3-.7-1.5-.7-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6 6 0 0 1-3-2.6c-.2-.4.2-.4.6-1.2.1-.1 0-.3 0-.4l-.7-1.6c-.2-.4-.4-.4-.5-.4h-.5a.9.9 0 0 0-.6.3 2.7 2.7 0 0 0-.9 2c0 1.2.9 2.4 1 2.5.1.2 1.7 2.7 4.2 3.7 1.6.7 2.2.7 3 .6.5-.1 1.3-.6 1.5-1.1.2-.5.2-1 .1-1.1l-.5-.3Z"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="12" cy="12" r="3.6" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="16.8" cy="7.2" r="1.2" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}

export function Avatar({ name, platform, size = 44 }: { name: string; platform?: Platform; size?: number }) {
  const hue = hueFor(name);
  return (
    <span className="avatar" style={{ width: size, height: size, ['--avatar-hue' as string]: hue }}>
      <span className="avatar-initials" style={{ fontSize: size * 0.38 }}>
        {initials(name)}
      </span>
      {platform && (
        <span className="avatar-badge">
          <PlatformMark platform={platform} size={Math.round(size * 0.4)} />
        </span>
      )}
    </span>
  );
}
