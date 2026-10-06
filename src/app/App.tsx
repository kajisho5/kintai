import { useState } from "react";
import { CalendarCheck, ClipboardCheck, Clock3, KeyRound, CreditCard, LayoutGrid, LogOut, Settings as SettingsIcon, Table2, Users } from "lucide-react";
import { BRAND } from "../brand";
import { SessionProvider, useSession } from "./session";
import { useHashRoute } from "./ui/hooks";
import { Avatar } from "./ui/kit";
import { BrandMark } from "./ui/BrandMark";
import { PasswordDialog } from "./ui/PasswordDialog";
import { Approvals } from "./pages/Approvals";
import { Attendance, AttendanceDetail, defaultYm } from "./pages/Attendance";
import { Billing } from "./pages/Billing";
import { Dashboard } from "./pages/Dashboard";
import { Employees } from "./pages/Employees";
import { Leave } from "./pages/Leave";
import { Settings } from "./pages/Settings";
import { Punch } from "./pages/Punch";

/** 無料トライアル・閲覧のみ・支払い遅延などの状態を知らせる帯 */
function TenantBanner() {
  const { me, isAdmin } = useSession();
  const t = me.tenant;
  if (t.state === "active") return null;
  const msg: Record<string, { tone: "info" | "warn" | "bad"; text: string }> = {
    trialing: { tone: "info", text: `無料トライアル中です（あと${t.trialDaysLeft ?? 0}日・${t.seatLimit}名まで）。` },
    trial_expired: { tone: "bad", text: "無料トライアルが終了しました。いまは閲覧のみで、打刻や申請はできません。" },
    past_due: { tone: "warn", text: "お支払いを確認できていません。このままだとご利用を停止する場合があります。" },
    canceled: { tone: "bad", text: "ご契約が終了しています。閲覧のみ可能です。" },
    suspended: { tone: "bad", text: "アカウントが停止されています。" },
  };
  const m = msg[t.state];
  if (!m) return null;
  return (
    <div className={`banner ${m.tone}`} role="status">
      <span>{m.text}{!isAdmin && t.state !== "trialing" ? " 管理者にご連絡ください。" : ""}</span>
      {isAdmin ? <a className="link" href="#/billing" style={{ marginLeft: "auto" }}>{t.state === "past_due" ? "お支払いを確認する" : "お申し込み・請求"}</a> : null}
    </div>
  );
}

function Shell() {
  const { me, isAdmin, logout, refresh } = useSession();
  const [route, go] = useHashRoute();
  const [ym, setYm] = useState(() => defaultYm(me.today, me.settings.fyStartMonth));
  const [pwOpen, setPwOpen] = useState(false);
  const myId = me.employee.id;

  const nav = isAdmin
    ? [
        { to: "dashboard", label: "ダッシュボード", icon: LayoutGrid },
        { to: "punch", label: "打刻", icon: Clock3 },
        { to: "attendance", label: "勤怠一覧", icon: Table2 },
        { to: "approvals", label: "申請・承認", icon: ClipboardCheck },
        { to: "leave", label: "有給管理", icon: CalendarCheck },
        { to: "employees", label: "社員管理", icon: Users },
        { to: "settings", label: "会社設定", icon: SettingsIcon },
        { to: "billing", label: "請求", icon: CreditCard },
      ]
    : [
        { to: "punch", label: "打刻", icon: Clock3 },
        { to: `attendance/${myId}`, label: "自分の勤怠", icon: Table2 },
        { to: "approvals", label: "申請", icon: ClipboardCheck },
        { to: "leave", label: "有給", icon: CalendarCheck },
      ];

  const [section = "", param] = (route || (isAdmin ? "dashboard" : "punch")).split("?")[0]!.split("/"); // ?以降は画面ごとの付加情報

  let page;
  switch (section) {
    case "punch": page = <Punch />; break;
    case "attendance":
      page = !isAdmin ? <AttendanceDetail id={myId} go={go} ym={ym} setYm={setYm} />
        : param ? <AttendanceDetail id={param} go={go} ym={ym} setYm={setYm} /> : <Attendance go={go} ym={ym} setYm={setYm} />;
      break;
    case "approvals": page = <Approvals />; break;
    case "leave": page = <Leave />; break;
    case "employees": page = isAdmin ? <Employees /> : <Dashboard go={go} />; break;
    case "settings": page = isAdmin ? <Settings /> : <Punch />; break;
    case "billing": page = isAdmin ? <Billing /> : <Punch />; break;
    default: page = isAdmin ? <Dashboard go={go} /> : <Punch />;
  }
  const activeKey = section === "attendance" && !isAdmin ? `attendance/${myId}` : section;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">{BRAND.name}</div>
            <div className="brand-co">{me.tenant.name}</div>
          </div>
        </div>
        <nav className="nav" aria-label="メイン">
          {nav.map(({ to, label, icon: Icon }) => (
            <a key={to} href={`#/${to}`} aria-current={activeKey === to ? "page" : undefined}>
              <Icon size={19} aria-hidden="true" />
              {label}
              {to === "approvals" && me.pending > 0 ? <span className="badge" aria-label={`${me.pending}件`}>{me.pending}</span> : null}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <Avatar name={me.employee.name} />
          <div>
            <b>{me.employee.name}</b>
            <small>{isAdmin ? "管理者" : me.employee.dept}</small>
          </div>
          <button type="button" className="btn sm text" onClick={() => setPwOpen(true)} aria-label="パスワードを変更" title="パスワードを変更"><KeyRound size={16} /></button>
          <button type="button" className="btn sm text" onClick={() => void logout()} aria-label="ログアウト" title="ログアウト"><LogOut size={16} /></button>
        </div>
      </aside>
      <main className="main">
        <TenantBanner />
        <div className="mobile-logout">
          <button type="button" className="btn sm text" onClick={() => setPwOpen(true)}><KeyRound size={14} />パスワード変更</button>
          <button type="button" className="btn sm text" onClick={() => void logout()}><LogOut size={14} />ログアウト</button>
        </div>
        {/* 一時パスワードのままでは API が使えないため、変更が済むまで本体は表示しない */}
        {me.mustChangePassword ? null : page}
      </main>
      <PasswordDialog open={pwOpen || me.mustChangePassword} required={me.mustChangePassword} onClose={() => setPwOpen(false)} onChanged={refresh} />
    </div>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
