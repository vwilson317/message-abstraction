import { useMemo, useState } from 'react';

export interface Toast {
  id: number;
  message: string;
}

let nextId = 1;

export function useToasts() {
  const [items, setItems] = useState<Toast[]>([]);
  // Stable callbacks, so components can list them as effect dependencies.
  const actions = useMemo(() => {
    const dismiss = (id: number) => setItems((list) => list.filter((t) => t.id !== id));
    const error = (message: string) => {
      const id = nextId++;
      setItems((list) => [...list.slice(-2), { id, message }]);
      setTimeout(() => dismiss(id), 6000);
    };
    return { dismiss, error };
  }, []);
  return { items, ...actions };
}

export function Toasts(props: { items: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {props.items.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.message}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => props.onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
