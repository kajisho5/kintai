import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";

/** 確認ダイアログ。onConfirm が失敗したらメッセージを表示して開いたままにする */
export function ConfirmDialog({ open, title, children, confirmLabel, danger, onConfirm, onClose }: { open: boolean; title: string; children: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="form">
        <div>{children}</div>
        <div className="form-error" role="alert">{error}</div>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>キャンセル</button>
          <button type="button" className={`btn ${danger ? "danger" : "primary"}`} disabled={busy} onClick={run}>{busy ? "処理中…" : confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}
