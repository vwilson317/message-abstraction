import { useEffect, useRef } from 'react';
import type { Conversation, Settings } from './api';
import { effectiveGroup } from '../../src/core/groups';
import { subscribe } from './events';

/** Only messages this fresh alert; anything older is history being read in. */
const FRESH_MS = 2 * 60 * 1000;

/**
 * Desktop alerts for new messages, per group (Romantic interests stay quiet
 * by default). WhatsApp and Instagram keep their own notifications; these
 * come from Inbox and can be turned off per group with the bell.
 */
export function useAlerts(options: {
  conversations: Conversation[];
  settings: Settings;
  /** The conversation on screen; no alert for it while the window has focus. */
  focusedId: string | null;
  onOpen: (conversationId: string) => void;
  enabled?: boolean;
}) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (options.enabled === false || typeof Notification === 'undefined') return;
    const startedAt = Date.now();
    return subscribe((event) => {
      if (event.type !== 'message.upserted' || Notification.permission !== 'granted') return;
      const { conversations, settings, focusedId, onOpen } = latest.current;
      const m = event.message;
      const now = Date.now();
      if (m.fromSelf || m.kind === 'system' || m.deleted) return;
      if (m.timestamp < startedAt - FRESH_MS || now - m.timestamp > FRESH_MS) return;
      const conversation = conversations.find((c) => c.id === m.conversationId);
      if (!conversation || conversation.sourceKind !== 'live') return;
      if (!settings.groupAlerts[effectiveGroup(conversation, now)]) return;
      if (focusedId === conversation.id && document.visibilityState === 'visible' && document.hasFocus()) return;

      const body =
        m.text ?? (m.attachments[0] ? `Sent ${m.attachments[0].type === 'image' ? 'a photo' : 'an attachment'}` : '');
      const title = conversation.isGroup ? `${m.senderName} · ${conversation.title}` : conversation.title;
      // The tag collapses duplicates when the inbox and the companion are both open.
      const notification = new Notification(title, { body: body.slice(0, 200), tag: m.id });
      notification.onclick = () => {
        window.focus();
        onOpen(conversation.id);
        notification.close();
      };
    });
  }, [options.enabled]);
}

/** Ask for permission when someone turns alerts on. Returns whether alerts can be shown. */
export async function ensureAlertPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}
