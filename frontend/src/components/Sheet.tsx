import { useEffect, type ReactNode } from 'react';
import { IconClose } from './Icons';

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="grabber" />
        <div className="sheet-header">
          <h2>{title}</h2>
          <button className="btn ghost icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmSheet(props: { open: boolean; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet open={props.open} onClose={props.onClose} title={props.title}>
      <div className="stack">
        <div>{props.body}</div>
        <div className="row">
          <button className="btn grow" onClick={props.onClose}>Cancel</button>
          <button className={`btn grow ${props.danger ? 'sell' : 'primary'}`} disabled={props.busy} onClick={props.onConfirm}>
            {props.busy ? 'Working…' : props.confirmLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
