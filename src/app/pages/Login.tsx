import { useState, type FormEvent } from "react";
import { BRAND } from "../../brand";
import { BrandMark } from "../ui/BrandMark";
import { api } from "../api";

const savedCompany = (): string => {
  try {
    return localStorage.getItem("company") ?? "";
  } catch {
    return "";
  }
};

export function Login({ onLogin }: { onLogin: () => void }) {
  const [company, setCompany] = useState(savedCompany);
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: { company: company.trim(), id: id.trim(), password } });
      try {
        localStorage.setItem("company", company.trim().toLowerCase());
      } catch {
        /* 保存できなくてもログインは成功している */
      }
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
          <div className="brand-name">{BRAND.name}</div>
        </div>
        <h1>ログイン</h1>
        <label>
          企業ID
          <input className="field" value={company} onChange={(e) => setCompany(e.target.value)} autoCapitalize="none" autoComplete="organization" autoFocus={!company} required />
        </label>
        <label>
          社員ID
          <input className="field" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" autoFocus={!!company} required />
        </label>
        <label>
          パスワード
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <div className="form-error" role="alert">{error}</div>
        <button className="btn primary" type="submit" disabled={busy || !company || !id || !password}>
          {busy ? "確認しています…" : "ログイン"}
        </button>
        <p className="note" style={{ margin: 0 }}><a href="#/forgot">パスワードをお忘れの方</a></p>
        <p className="note" style={{ margin: 0 }}>はじめての方は <a href="#/signup">無料で始める</a></p>
        {import.meta.env.DEV ? (
          <p className="note" style={{ margin: 0 }}>開発環境: 企業ID demo / 管理者 e16 / 一般社員 e01〜e18。パスワードは <code>npm run db:seed</code> 時の SEED_PASSWORD（既定 demo-pass-1234）</p>
        ) : null}
      </form>
    </main>
  );
}
