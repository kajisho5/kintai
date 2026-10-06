import { useEffect, useState, type FormEvent } from "react";
import { BRAND } from "../../brand";
import { api } from "../api";
import { BrandMark } from "../ui/BrandMark";

export function Signup({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ companyName: "", code: "", adminName: "", adminId: "admin", email: "", password: "", acceptTerms: false });
  const [codeMsg, setCodeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  // 企業IDの空き状況を、入力が止まってから確認する
  useEffect(() => {
    const code = f.code.trim().toLowerCase();
    if (!code) return setCodeMsg(null);
    const t = setTimeout(() => {
      api<{ available: boolean; message?: string }>(`/api/signup/check?code=${encodeURIComponent(code)}`)
        .then((r) => setCodeMsg({ ok: r.available, text: r.available ? "この企業IDは使えます" : (r.message ?? "") }))
        .catch(() => setCodeMsg(null));
    }, 400);
    return () => clearTimeout(t);
  }, [f.code]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ code: string }>("/api/signup", { method: "POST", body: f });
      try {
        localStorage.setItem("company", res.code);
      } catch {
        /* 保存できなくても登録は完了している */
      }
      window.location.hash = "/";
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登録に失敗しました");
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="login-card signup" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <BrandMark />
          <div className="brand-name">{BRAND.name}</div>
        </div>
        <h1>無料で始める</h1>
        <p className="note" style={{ margin: 0 }}>30日間、すべての機能を無料でお試しいただけます。クレジットカードは不要です。</p>
        <label>会社名<input className="field" value={f.companyName} onChange={(e) => set("companyName", e.target.value)} autoComplete="organization" required maxLength={60} /></label>
        <label>
          企業ID（ログインに使います）
          <input className="field" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="例: acme-kogyo" autoCapitalize="none" required maxLength={32} aria-describedby="code-msg" />
          <span id="code-msg" className={`hint ${codeMsg ? (codeMsg.ok ? "ok" : "bad") : ""}`}>{codeMsg?.text ?? "半角英小文字・数字・ハイフン、3〜32文字"}</span>
        </label>
        <label>管理者のお名前<input className="field" value={f.adminName} onChange={(e) => set("adminName", e.target.value)} autoComplete="name" required maxLength={40} /></label>
        <label>
          管理者の社員ID
          <input className="field" value={f.adminId} onChange={(e) => set("adminId", e.target.value)} autoCapitalize="none" required maxLength={30} />
        </label>
        <label>メールアドレス<input className="field" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} autoComplete="email" required /></label>
        <label>
          パスワード（10文字以上）
          <input className="field" type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" minLength={10} required />
        </label>
        <label className="check">
          <input type="checkbox" checked={f.acceptTerms} onChange={(e) => set("acceptTerms", e.target.checked)} required />
          <span><a href="/terms.html" target="_blank" rel="noreferrer">利用規約</a>と<a href="/privacy.html" target="_blank" rel="noreferrer">プライバシーポリシー</a>に同意します</span>
        </label>
        <div className="form-error" role="alert">{error}</div>
        <button className="btn primary" type="submit" disabled={busy || !f.acceptTerms || (codeMsg !== null && !codeMsg.ok)}>{busy ? "登録しています…" : "無料トライアルを始める"}</button>
        <p className="note" style={{ margin: 0 }}>すでに登録済みの方は <a href="#/">ログイン</a>（{BRAND.name}）</p>
      </form>
    </main>
  );
}
