import { useState } from 'react';
import { api, type ConnectorStatus } from '../api';
import { PlatformMark } from './Avatar';
import { Modal } from './Modal';

const STATE_LABEL: Record<ConnectorStatus['state'], string> = {
  stopped: 'Not connected',
  starting: 'Starting…',
  awaiting_auth: 'Waiting for you to scan',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Error',
};

interface Props {
  connectors: ConnectorStatus[];
  onClose: () => void;
  onImport: () => void;
  onError: (message: string) => void;
}

export function AccountsDialog({ connectors, onClose, onImport, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

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
    <Modal title="Accounts" onClose={onClose} wide>
      {connectors.map((c) => (
        <section key={c.id} className="account">
          <div className="account-head">
            <PlatformMark platform={c.platform} size={28} />
            <div>
              <h3>{c.label}</h3>
              <p className={`account-state state-text-${c.state}`}>
                <span className={`state-dot state-${c.state}`} /> {STATE_LABEL[c.state]}
                {c.detail && <span className="account-detail"> · {c.detail}</span>}
              </p>
            </div>
            <div className="account-actions">
              {(c.state === 'stopped' || c.state === 'error') && (
                <button
                  className="btn btn-primary"
                  disabled={busy === c.id}
                  onClick={() => void run(c.id, api.connect)}
                >
                  Connect
                </button>
              )}
              {c.state !== 'stopped' && c.state !== 'error' && (
                <button className="btn" disabled={busy === c.id} onClick={() => void run(c.id, api.disconnect)}>
                  Disconnect
                </button>
              )}
              {c.state === 'connected' && (
                <button
                  className="btn btn-danger-quiet"
                  disabled={busy === c.id}
                  onClick={() => {
                    if (confirm(`Unlink this device from ${c.label}? Imported and synced messages stay here.`)) {
                      void run(c.id, api.logout);
                    }
                  }}
                >
                  Unlink
                </button>
              )}
            </div>
          </div>

          {c.state === 'awaiting_auth' && c.qr && (
            <div className="qr">
              <img src={c.qr} alt="WhatsApp pairing QR code" width={240} height={240} />
              <ol>
                <li>Open WhatsApp on your phone</li>
                <li>
                  Go to <strong>Settings → Linked devices</strong>
                </li>
                <li>
                  Tap <strong>Link a device</strong> and scan this code
                </li>
              </ol>
            </div>
          )}

          {c.platform === 'whatsapp' && c.state !== 'connected' && c.state !== 'awaiting_auth' && (
            <p className="hint">
              Links as a WhatsApp Web device, like a second screen for your phone. Recent history syncs in after
              linking. This uses an unofficial client (Baileys); WhatsApp's terms don't allow that, so a ban is
              possible, if unlikely for normal personal use.
            </p>
          )}
        </section>
      ))}

      <section className="account">
        <div className="account-head">
          <PlatformMark platform="instagram" size={28} />
          <div>
            <h3>Instagram</h3>
            <p className="account-state">
              <span className="state-dot state-stopped" /> Import only, for now
            </p>
          </div>
          <div className="account-actions">
            <button className="btn" onClick={onImport}>
              Import export
            </button>
          </div>
        </div>
        <p className="hint">
          Live Instagram DMs need either Meta's official API (professional accounts only) or an unofficial bridge. Until
          that's chosen, import your data: Instagram → Settings →{' '}
          <strong>Accounts Center → Your information and permissions → Download your information</strong>, pick{' '}
          <strong>Messages</strong> and format <strong>JSON</strong>.
        </p>
      </section>
    </Modal>
  );
}
