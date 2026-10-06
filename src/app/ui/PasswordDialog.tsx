import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { api } from "../api";

export function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setCurrent("");
      setNext("");
      setAgain("");
      setError("");
      setDone(false);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setError("新しいパスワードが一致しません");
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/password", { method: "POST", body: { current, next } });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "変更に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dlg" onClose={onClose} aria-labelledby="pw-title">
      <header>
        <h2 id="pw-title">パスワードを変更</h2>
        <button type="button" className="btn sm text" onClick={onClose} aria-label="閉じる"><X size={16} /></button>
      </header>
      {done ? (
        <div className="form">
          <p style={{ margin: 0 }} role="status">パスワードを変更しました。他の端末ではログアウトされます。</p>
          <div className="actions"><button type="button" className="btn primary" onClick={onClose}>閉じる</button></div>
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          <label>現在のパスワード<input className="field" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>
          <label>新しいパスワード（8文字以上）<input className="field" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
          <label>新しいパスワード（確認）<input className="field" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></label>
          <div className="form-error" role="alert">{error}</div>
          <div className="actions">
            <button type="button" className="btn" onClick={onClose}>キャンセル</button>
            <button type="submit" className="btn primary" disabled={busy || !current || !next || !again}>{busy ? "変更中…" : "変更する"}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
