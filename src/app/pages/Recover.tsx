import { useEffect, useState, type FormEvent } from "react";
import { BRAND } from "../../brand";
import { api } from "../api";
import { BrandMark } from "../ui/BrandMark";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="login">
      <div className="login-card">
        <div className="brand" style={{ padding: 0 }}>
          <BrandMark />
          <div className="brand-name">{BRAND.name}</div>
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

const saved = (): string => {
  try {
    return localStorage.getItem("company") ?? "";
  } catch {
    return "";
  }
};

/** パスワードを忘れたとき: 企業IDと登録メールアドレスを入力すると、再設定のリンクをメールで送る */
export function Forgot() {
  const [company, setCompany] = useState(saved);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/forgot", { method: "POST", body: { company: company.trim(), email: email.trim() } });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <Shell title="メールを確認してください">
        <p style={{ margin: 0 }} role="status">登録されているメールアドレスの場合は、パスワード再設定のご案内をお送りしました。リンクの有効期間は60分です。</p>
        <p className="note" style={{ margin: 0 }}>届かない場合は、迷惑メールフォルダをご確認ください。メールアドレスを登録していない場合は、管理者にパスワードの再発行を依頼してください。</p>
        <a className="btn" href="#/">ログインに戻る</a>
      </Shell>
    );
  }
  return (
    <Shell title="パスワードの再設定">
      <form className="signup" style={{ display: "grid", gap: 14 }} onSubmit={submit}>
        <p className="note" style={{ margin: 0 }}>企業IDと、ご登録のメールアドレスを入力してください。再設定のリンクをお送りします。</p>
        <label>企業ID<input className="field" value={company} onChange={(e) => setCompany(e.target.value)} autoCapitalize="none" required /></label>
        <label>メールアドレス<input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label>
        <div className="form-error" role="alert">{error}</div>
        <button className="btn primary" type="submit" disabled={busy || !company || !email}>{busy ? "送信しています…" : "再設定のリンクを送る"}</button>
        <a href="#/" className="note">ログインに戻る</a>
      </form>
    </Shell>
  );
}

/** メールのリンクから開く: 新しいパスワードを設定する */
export function Reset() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const company = params.get("company") ?? "";
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) return setError("新しいパスワードが一致しません");
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/reset", { method: "POST", body: { company, token, password } });
      try {
        localStorage.setItem("company", company);
      } catch {
        /* 保存できなくても再設定は完了している */
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "再設定に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Shell title="パスワードを変更しました">
        <p style={{ margin: 0 }} role="status">新しいパスワードでログインできます。</p>
        <a className="btn primary" href="#/">ログインへ</a>
      </Shell>
    );
  }
  if (!company || !token) {
    return (
      <Shell title="リンクが正しくありません">
        <p style={{ margin: 0 }}>メールに記載のリンクをそのまま開いてください。</p>
        <a className="btn" href="#/forgot">もう一度、再設定を申し込む</a>
      </Shell>
    );
  }
  return (
    <Shell title="新しいパスワードを設定">
      <form style={{ display: "grid", gap: 14 }} onSubmit={submit}>
        <label>新しいパスワード（8文字以上）<input className="field" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></label>
        <label>新しいパスワード（確認）<input className="field" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></label>
        <div className="form-error" role="alert">{error}</div>
        <button className="btn primary" type="submit" disabled={busy || !password || !again}>{busy ? "変更中…" : "パスワードを変更する"}</button>
      </form>
    </Shell>
  );
}

/** 確認メールのリンクから開く: メールアドレスの確認を完了する（ログイン中でも未ログインでも開ける） */
export function Verify({ loggedIn, onDone }: { loggedIn: boolean; onDone: () => void }) {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const company = params.get("company") ?? "";
  const token = params.get("token") ?? "";
  const [state, setState] = useState<{ status: "working" } | { status: "ok" } | { status: "error"; message: string }>(
    company && token ? { status: "working" } : { status: "error", message: "メールに記載のリンクをそのまま開いてください。" },
  );

  useEffect(() => {
    if (!company || !token) return;
    let live = true;
    api("/api/signup/verify", { method: "POST", body: { company, token } })
      .then(() => live && setState({ status: "ok" }))
      .catch((err) => live && setState({ status: "error", message: err instanceof Error ? err.message : "確認に失敗しました" }));
    return () => {
      live = false;
    };
  }, [company, token]);

  const next = () => {
    window.location.hash = "/";
    onDone();
  };
  if (state.status === "working") {
    return (
      <Shell title="確認しています…">
        <p style={{ margin: 0 }} role="status">少々お待ちください。</p>
      </Shell>
    );
  }
  if (state.status === "ok") {
    return (
      <Shell title="メールアドレスを確認しました">
        <p style={{ margin: 0 }} role="status">ありがとうございます。確認が完了しました。</p>
        <button type="button" className="btn primary" onClick={next}>{loggedIn ? "アプリに戻る" : "ログインへ"}</button>
      </Shell>
    );
  }
  return (
    <Shell title="確認できませんでした">
      <p style={{ margin: 0 }} role="alert">{state.message}</p>
      <button type="button" className="btn" onClick={next}>{loggedIn ? "アプリに戻る" : "ログインへ"}</button>
    </Shell>
  );
}
