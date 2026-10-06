import { useState, type FormEvent } from "react";
import { api } from "../api";

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#1d3a5c" />
      <path d="M7 22 L14 12 L18 17 L25 8" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="8" r="2.4" fill="#0f8a94" stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}

export function Login({ onLogin }: { onLogin: () => void }) {
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: { id: id.trim(), password } });
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました");
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <BrandMark />
          <div className="brand-name">Kintai</div>
        </div>
        <h1>ログイン</h1>
        <label>
          社員ID
          <input className="field" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label>
          パスワード
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <div className="form-error" role="alert">{error}</div>
        <button className="btn primary" type="submit" disabled={busy || !id || !password}>
          {busy ? "確認しています…" : "ログイン"}
        </button>
        {import.meta.env.DEV ? (
          <p className="note" style={{ margin: 0 }}>開発環境: 管理者 e16 / 一般社員 e01〜e18。パスワードは <code>npm run db:seed</code> 時の SEED_PASSWORD（既定 kintai-demo）</p>
        ) : null}
      </form>
    </main>
  );
}
