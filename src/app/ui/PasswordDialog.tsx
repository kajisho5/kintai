import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Modal } from "./Modal";

/** パスワード変更。required=true は初回ログイン時（一時パスワードのまま）で、変更するまで閉じられない */
export function PasswordDialog({ open, onClose, required, onChanged }: { open: boolean; onClose: () => void; required?: boolean; onChanged?: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={required ? "パスワードを設定してください" : "パスワードを変更"} dismissible={!required}>
      {open ? <PasswordForm required={required} onClose={onClose} onChanged={onChanged} /> : null}
    </Modal>
  );
}

function PasswordForm({ required, onClose, onChanged }: { required?: boolean; onClose: () => void; onChanged?: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

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

  if (done) {
    // 成功を伝えてから閉じる。初回設定のときは、閉じた時点で画面が通常の状態に切り替わる
    const finish = () => {
      onChanged?.();
      onClose();
    };
    return (
      <div className="form">
        <p style={{ margin: 0 }} role="status">パスワードを変更しました。他の端末ではログアウトされます。</p>
        <div className="actions"><button type="button" className="btn primary" onClick={finish}>閉じる</button></div>
      </div>
    );
  }
  return (
    <form className="form" onSubmit={submit}>
      {required ? <p style={{ margin: 0 }}>管理者から受け取った一時パスワードのままでは、ほかの操作ができません。自分だけが知っているパスワードに変更してください。</p> : null}
      <label>{required ? "一時パスワード" : "現在のパスワード"}<input className="field" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus /></label>
      <label>新しいパスワード（8文字以上）<input className="field" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
      <label>新しいパスワード（確認）<input className="field" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></label>
      <div className="form-error" role="alert">{error}</div>
      <div className="actions">
        {required ? null : <button type="button" className="btn" onClick={onClose}>キャンセル</button>}
        <button type="submit" className="btn primary" disabled={busy || !current || !next || !again}>{busy ? "変更中…" : "変更する"}</button>
      </div>
    </form>
  );
}
