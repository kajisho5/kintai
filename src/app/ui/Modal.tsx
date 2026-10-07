import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** <dialog> を使った共通のモーダル。Esc・背景クリック・閉じるボタンで閉じる（dismissible=false なら閉じられない） */
export function Modal({ open, onClose, title, children, wide, dismissible = true }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; dismissible?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dlg ${wide ? "wide" : ""}`}
      aria-label={title}
      onClose={onClose}
      onCancel={(e) => !dismissible && e.preventDefault()}
      onMouseDown={(e) => dismissible && e.target === ref.current && onClose()}
    >
      {open ? (
        <>
          <header>
            <h2>{title}</h2>
            {dismissible ? <button type="button" className="btn sm text" onClick={onClose} aria-label="閉じる"><X size={16} /></button> : null}
          </header>
          {children}
        </>
      ) : null}
    </dialog>
  );
}
