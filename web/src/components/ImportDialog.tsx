import { useState, type DragEvent } from 'react';
import { api, type ImportSummary } from '../api';
import { PlatformMark } from './Avatar';
import { Modal } from './Modal';

interface Props {
  onClose: () => void;
  onOpen: (conversationId: string) => void;
}

export function ImportDialog({ onClose, onOpen }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [selfName, setSelfName] = useState('');
  const [dateOrder, setDateOrder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [dragging, setDragging] = useState(false);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importFile(file, { selfName: selfName.trim(), dateOrder }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };

  if (result) {
    return (
      <Modal title="Imported" onClose={onClose}>
        <ul className="import-results">
          {result.conversations.map((c) => (
            <li key={c.id}>
              <PlatformMark platform={c.platform} />
              <span className="import-title">{c.title}</span>
              <span className="import-count">{c.messageCount.toLocaleString()} messages</span>
              <button className="btn btn-quiet" onClick={() => onOpen(c.id)}>
                Open
              </button>
            </li>
          ))}
        </ul>
        {result.warnings.length > 0 && (
          <ul className="warnings">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        <div className="button-row end">
          <button className="btn" onClick={() => setResult(null)}>
            Import another
          </button>
          <button
            className="btn btn-primary"
            onClick={() => (result.conversations[0] ? onOpen(result.conversations[0].id) : onClose())}
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Import a chat export" onClose={onClose}>
      <label
        className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input type="file" accept=".txt,.zip,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file ? (
          <>
            <strong>{file.name}</strong>
            <span>{(file.size / 1024 / 1024).toFixed(1)} MB · click to choose another</span>
          </>
        ) : (
          <>
            <strong>Drop a file here or click to choose</strong>
            <span>WhatsApp .txt or .zip · Instagram .zip or message_1.json</span>
          </>
        )}
      </label>

      <label className="field">
        <span>Your name as it appears in the chat (optional)</span>
        <input
          value={selfName}
          onChange={(e) => setSelfName(e.target.value)}
          placeholder="Usually worked out for you"
        />
      </label>

      <details className="advanced">
        <summary>Advanced</summary>
        <label className="field">
          <span>Date format (WhatsApp)</span>
          <select value={dateOrder} onChange={(e) => setDateOrder(e.target.value)}>
            <option value="">Detect automatically</option>
            <option value="DMY">Day first (31/12/24)</option>
            <option value="MDY">Month first (12/31/24)</option>
            <option value="YMD">Year first (2024-12-31)</option>
          </select>
        </label>
      </details>

      {error && <p className="error">{error}</p>}

      <div className="button-row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!file || busy} onClick={() => void submit()}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>

      <details className="howto">
        <summary>How do I export?</summary>
        <p>
          <strong>WhatsApp:</strong> open the chat → tap the name (iPhone) or ⋮ → More (Android) →{' '}
          <strong>Export chat</strong>. Choose “Attach media” to see photos here.
        </p>
        <p>
          <strong>Instagram:</strong> Settings → Accounts Center → Your information and permissions → Download your
          information → Messages, format <strong>JSON</strong>. Big exports import faster from the terminal:{' '}
          <code>npm run import -- path/to/export.zip</code>
        </p>
      </details>
    </Modal>
  );
}
