import { useEffect, useState } from "react";
import { CreditCard, ExternalLink } from "lucide-react";
import { BRAND } from "../../brand";
import { api, useApi } from "../api";
import type { BillingInfo } from "../../domain/api";
import { useSession } from "../session";
import { Pill } from "../ui/kit";

const STATE_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad" | "live" }> = {
  trialing: { text: "無料トライアル中", tone: "live" },
  trial_expired: { text: "トライアル終了", tone: "bad" },
  active: { text: "ご契約中", tone: "ok" },
  past_due: { text: "お支払いの確認待ち", tone: "warn" },
  canceled: { text: "解約済み", tone: "bad" },
  suspended: { text: "停止中", tone: "bad" },
};

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const dateOf = (ms: number) => new Date(ms).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" });

export function Billing() {
  const { refresh } = useSession();
  const { data, error, reload } = useApi<BillingInfo>("/api/billing");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const returned = window.location.hash.includes("checkout=success");
  const [waiting, setWaiting] = useState(returned);

  // 決済から戻ったら、契約状態の反映を待つ（Stripe からの通知は数秒かかることがある）
  useEffect(() => {
    if (!waiting) return;
    if (data?.state === "active") {
      setWaiting(false);
      refresh();
      return;
    }
    const t = setTimeout(reload, 2000);
    const give = setTimeout(() => setWaiting(false), 30_000);
    return () => {
      clearTimeout(t);
      clearTimeout(give);
    };
  }, [waiting, data, reload, refresh]);

  if (!data) return <p className={error ? "status-error" : ""} role="status">{error ?? "読み込んでいます…"}</p>;
  const st = STATE_LABEL[data.state] ?? { text: data.state, tone: "ok" as const };

  const go = async (path: "checkout" | "portal") => {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ url: string }>(`/api/billing/${path}`, { method: "POST" });
      window.location.href = r.url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "処理に失敗しました");
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>請求・お支払い</h1>
          <p>ご利用状況とお支払いの管理</p>
        </div>
      </header>
      <div className="stack">
        {waiting ? <div className="banner info" role="status">お申し込みを確認しています。数秒お待ちください…</div> : null}
        {returned && !waiting && data.state === "active" ? <div className="banner info" role="status">お申し込みありがとうございます。ご契約が開始されました。</div> : null}
        {err ? <div className="banner bad" role="alert">{err}</div> : null}
        {data.state === "past_due" ? (
          <div className="banner warn" role="alert">
            お支払いを確認できていません。「請求・お支払い方法の管理」からカード情報をご確認ください。{data.graceEndsAt ? `${dateOf(data.graceEndsAt)}までにお支払いが確認できない場合、閲覧のみとなります。` : ""}
          </div>
        ) : null}

        <section className="panel" aria-labelledby="b-title">
          <div className="panel-head"><h2 id="b-title">ご利用状況</h2><Pill tone={st.tone}>{st.text}</Pill></div>
          <div className="panel-body">
            <dl className="kv" style={{ maxWidth: 520 }}>
              <div><dt>在籍人数（課金の対象）</dt><dd>{data.seatsUsed}名</dd></div>
              <div><dt>料金</dt><dd>{yen(data.pricePerSeatJpy)} / 人・月（税抜）</dd></div>
              <div><dt>現在の人数での月額の目安</dt><dd>{yen(data.monthlyEstimateJpy)}（税抜）</dd></div>
              {data.state === "trialing" ? <div><dt>無料トライアルの終了</dt><dd>{dateOf(data.trialEndsAt)}（あと{data.trialDaysLeft}日）</dd></div> : null}
            </dl>
            <p className="note">人数は、在職中の社員の数です。月の途中で増減した場合は、日割りで精算されます。退職処理をした社員は数えません。消費税は別途かかります。</p>
          </div>
        </section>

        <section className="panel" aria-labelledby="c-title">
          <div className="panel-head"><h2 id="c-title">{data.hasSubscription ? "お支払いの管理" : "お申し込み"}</h2></div>
          <div className="panel-body" style={{ display: "grid", gap: 12 }}>
            {!data.configured ? (
              <p style={{ margin: 0 }}>現在、オンラインでのお申し込みは準備中です。ご利用を希望される場合は、<a href={`mailto:${BRAND.operator.email}`}>{BRAND.operator.email}</a> までご連絡ください。</p>
            ) : data.hasSubscription ? (
              <>
                <p style={{ margin: 0 }}>お支払い方法の変更、請求書・領収書の確認、解約は、Stripe の管理ページから行えます。</p>
                <div><button type="button" className="btn primary" disabled={busy} onClick={() => go("portal")}><ExternalLink size={16} />請求・お支払い方法の管理</button></div>
              </>
            ) : (
              <>
                <p style={{ margin: 0 }}>クレジットカードでお申し込みいただけます。決済は Stripe の画面で行い、当サービスではカード情報を保存しません。お申し込み後すぐに、ご契約が開始されます。</p>
                <div><button type="button" className="btn primary" disabled={busy} onClick={() => go("checkout")}><CreditCard size={16} />お申し込みへ進む</button></div>
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
