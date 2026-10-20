import { useEffect, useRef, type ReactNode } from 'react';

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${props.wide ? 'modal-wide' : ''}`}
      onClose={props.onClose}
      onClick={(e) => e.target === ref.current && props.onClose()}
      aria-label={props.title}
    >
      <header className="modal-header">
        <h2>{props.title}</h2>
        <button className="icon-btn" onClick={props.onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="modal-body">{props.children}</div>
    </dialog>
  );
}
