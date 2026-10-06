import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { Copy } from "lucide-react";
import { api } from "../api";
import type { TwoFactorSetup } from "../../domain/api";
import { Modal } from "./Modal";

interface Status {
  enabled: boolean;
  required: boolean;
}

/**
 * 二段階認証の設定・解除。required=true は、会社が管理者に必須にしているのに未設定のとき。設定するまで閉じられない。
 * 認証アプリ（Google Authenticator・Microsoft Authenticator など）で QR を読み取り、表示される6桁で確認する。
 */
export function TwoFactorDialog({ open, onClose, required, onChanged }: { open: boolean; onClose: () => void; required?: boolean; onChanged?: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={required ? "二段階認証を設定してください" : "二段階認証"} dismissible={!required} wide>
      {open ? <Body required={required} onClose={onClose} onChanged={onChanged} /> : null}
    </Modal>
  );
}

function Body({ required, onClose, onChanged }: { required?: boolean; onClose: () => void; onChanged?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<(TwoFactorSetup & { qr: string }) | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<Status>("/api/auth/2fa").then(setStatus).catch((e) => setError(e instanceof Error ? e.message : "読み込めませんでした"));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      const s = await api<TwoFactorSetup>("/api/auth/2fa/setup", { method: "POST" });
      setSetup({ ...s, qr: await QRCode.toDataURL(s.uri, { margin: 1, width: 200 }) });
    });
  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ recoveryCodes: string[] }>("/api/auth/2fa/enable", { method: "POST", body: { code } });
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      setStatus({ enabled: true, required: !!required });
    });
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api("/api/auth/2fa/disable", { method: "POST", body: { password, code } });
      setStatus({ enabled: false, required: false });
      setPassword("");
      setCode("");
      onChanged?.();
    });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes!.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const finish = () => {
    onChanged?.();
    onClose();
  };

  if (!status) return <div className="form"><p role="status">{error || "読み込んでいます…"}</p></div>;

  if (codes) {
    return (
      <div className="form">
        <p style={{ margin: 0 }} role="status"><b>二段階認証を有効にしました。</b>次の回復コードを、安全な場所に保管してください。スマートフォンを失くしたときに、1つにつき1回だけ、確認コードの代わりに使えます。この画面を閉じると、再表示できません。</p>
        <div className="banner info" style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
          {codes.map((c) => <code key={c} className="pw">{c}</code>)}
        </div>
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn" onClick={() => void copy()}><Copy size={16} />{copied ? "コピーしました" : "すべてコピー"}</button>
          <button type="button" className="btn primary" onClick={finish}>保管したので閉じる</button>
        </div>
      </div>
    );
  }

  if (!status.enabled) {
    return (
      <div className="form">
        {required ? <p style={{ margin: 0 }}>会社の設定で、管理者は二段階認証が必須です。設定が済むまで、ほかの操作はできません。</p> : <p style={{ margin: 0 }}>ログインのとき、パスワードに加えて、スマートフォンの認証アプリに表示される6桁のコードが必要になります。パスワードが漏れても、第三者はログインできません。</p>}
        {!setup ? (
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void start()}>設定を始める</button>
          </div>
        ) : (
          <form className="form" onSubmit={enable} style={{ padding: 0 }}>
            <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
              <li>スマートフォンに、認証アプリ（Google Authenticator・Microsoft Authenticator など）をインストールします。</li>
              <li>アプリで、次のQRコードを読み取ります。読み取れない場合は、秘密鍵を手入力します。</li>
            </ol>
            <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
              <img src={setup.qr} width={200} height={200} alt="二段階認証のQRコード" style={{ border: "1px solid var(--line)", borderRadius: 4 }} />
              <div style={{ display: "grid", gap: 4 }}>
                <small className="hint">秘密鍵（手入力用）</small>
                <code className="pw" style={{ wordBreak: "break-all" }}>{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
              </div>
            </div>
            <label>
              3. アプリに表示された6桁のコード
              <input className="field" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200, fontSize: 20, letterSpacing: 4 }} required autoFocus />
            </label>
            <div className="form-error" role="alert">{error}</div>
            <div className="actions"><button type="submit" className="btn primary" disabled={busy || code.replace(/\s/g, "").length < 6}>有効にする</button></div>
          </form>
        )}
        {!setup ? <div className="form-error" role="alert">{error}</div> : null}
        {!required ? <div className="actions"><button type="button" className="btn" onClick={onClose}>閉じる</button></div> : null}
      </div>
    );
  }

  return (
    <div className="form">
      <p style={{ margin: 0 }} role="status">二段階認証は<b>有効</b>です。ログインのとき、確認コードが必要です。</p>
      {status.required ? (
        <p className="note" style={{ margin: 0 }}>会社の設定で、管理者は二段階認証が必須のため、解除できません。</p>
      ) : (
        <form className="form" onSubmit={disable} style={{ padding: 0 }}>
          <b>解除する</b>
          <label>パスワード<input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
          <label>確認コード（または回復コード）<input className="field" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required style={{ maxWidth: 240 }} /></label>
          <div className="form-error" role="alert">{error}</div>
          <div className="actions"><button type="submit" className="btn" disabled={busy || !password || !code}>二段階認証を解除する</button></div>
        </form>
      )}
      <div className="actions"><button type="button" className="btn primary" onClick={onClose}>閉じる</button></div>
    </div>
  );
}
