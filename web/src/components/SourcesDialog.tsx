import { useState } from 'react';
import { api, type ConnectorStatus } from '../api';
import { PlatformMark } from './Avatar';
import { Modal } from './Modal';

const STATE_LABEL: Record<ConnectorStatus['state'], string> = {
  stopped: 'Off',
  starting: 'Starting…',
  needs_setup: 'Needs setup',
  connected: 'Watching',
  error: 'Error',
};

/** Opens System Settings → Privacy & Security → Full Disk Access on a Mac. */
const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

interface Props {
  connectors: ConnectorStatus[];
  onClose: () => void;
  onImport: () => void;
  onError: (message: string) => void;
}

function StateLine({ status }: { status: ConnectorStatus }) {
  return (
    <p className={`account-state state-text-${status.state}`}>
      <span className={`state-dot state-${status.state}`} /> {STATE_LABEL[status.state]}
    </p>
  );
}

export function SourcesDialog({ connectors, onClose, onImport, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const whatsapp = connectors.find((c) => c.id === 'whatsapp-mac');
  const instagram = connectors.find((c) => c.id === 'instagram-web');

  const run = async (id: string, action: (id: string) => Promise<void>) => {
    setBusy(id);
    try {
      await action(id);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Sources" onClose={onClose} wide>
      <p className="hint sources-intro">
        Inbox reads the apps you already use, on this computer. It never connects to WhatsApp or Instagram itself and
        never sends anything; you reply in the apps.
      </p>

      <section className="account">
        <div className="account-head">
          <PlatformMark platform="whatsapp" size={28} />
          <div>
            <h3>WhatsApp Desktop</h3>
            {whatsapp ? <StateLine status={whatsapp} /> : <p className="account-state">Mac only</p>}
          </div>
          {whatsapp && (
            <div className="account-actions">
              {whatsapp.state === 'stopped' || whatsapp.state === 'error' || whatsapp.state === 'needs_setup' ? (
                <button
                  className="btn btn-primary"
                  disabled={busy === whatsapp.id}
                  onClick={() =>
                    void run(whatsapp.id, async (id) => {
                      await api.disconnect(id).catch(() => {});
                      await api.connect(id);
                    })
                  }
                >
                  Start
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={busy === whatsapp.id}
                  onClick={() => void run(whatsapp.id, api.disconnect)}
                >
                  Stop
                </button>
              )}
            </div>
          )}
        </div>
        {whatsapp?.detail && <p className="account-detail-block">{whatsapp.detail}</p>}
        {whatsapp?.state === 'needs_setup' && /Full Disk Access/.test(whatsapp.detail ?? '') && (
          <p>
            <a className="btn" href={FULL_DISK_ACCESS_URL}>
              Open Full Disk Access settings
            </a>
          </p>
        )}
        <p className="hint">
          Reads the Mac app’s own local database, read-only, while it runs. It holds what WhatsApp has synced to your
          Mac, which may not be your whole history; import a chat export from your phone for older messages.
          {!whatsapp && ' This server isn’t running on a Mac, so WhatsApp Desktop isn’t available here.'}
        </p>
      </section>

      <section className="account">
        <div className="account-head">
          <PlatformMark platform="instagram" size={28} />
          <div>
            <h3>Instagram in Chrome</h3>
            {instagram && <StateLine status={instagram} />}
          </div>
        </div>
        {instagram && instagram.state !== 'needs_setup' ? (
          <p className="hint">
            {instagram.state === 'connected'
              ? 'The extension is reading the conversation you have open. '
              : 'The extension is installed; it reads whenever an Instagram conversation is open. '}
            Open its side panel (the Inbox icon in Chrome’s toolbar) to see insights next to the chat.
          </p>
        ) : (
          <ol className="setup-steps">
            <li>
              Build it once: <code>npm run build</code> (creates <code>dist/extension</code>).
            </li>
            <li>
              In Chrome, open <code>chrome://extensions</code>, turn on <strong>Developer mode</strong>, click{' '}
              <strong>Load unpacked</strong> and pick the <code>dist/extension</code> folder.
            </li>
            <li>
              Open a conversation at <code>instagram.com/direct</code>. Click the Inbox icon in the toolbar for the side
              panel.
            </li>
          </ol>
        )}
        <p className="hint">
          It reads only what’s on screen: no requests of its own, no clicks. Instagram shows about 20 messages at a
          time, so scroll up (or use “Read earlier messages” in the panel) to bring in older ones.
        </p>
      </section>

      <section className="account">
        <div className="account-head">
          <span className="platform-mark import-mark" style={{ width: 28, height: 28 }}>
            ⇪
          </span>
          <div>
            <h3>Chat exports</h3>
            <p className="account-state">WhatsApp .txt/.zip · Instagram JSON</p>
          </div>
          <div className="account-actions">
            <button className="btn" onClick={onImport}>
              Import
            </button>
          </div>
        </div>
        <p className="hint">For full history from your phone, or chats you no longer have open anywhere.</p>
      </section>
    </Modal>
  );
}
