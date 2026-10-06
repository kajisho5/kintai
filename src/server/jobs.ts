import type { BillingGateway } from "./billing";
import type { Clock } from "./clock";
import type { TenantManager } from "./control";
import { templates, type Mailer } from "./mail";
import { syncSeats } from "./seats";
import { activeCount } from "./context";

const DAY = 86400_000;
export const TRIAL_REMINDER_DAYS = 3;

export interface JobDeps {
  manager: TenantManager;
  mailer: Mailer;
  billing: BillingGateway;
  clockFor: (tz: string) => Clock;
  appUrl?: string;
}

export interface JobSummary {
  reminders: number;
  seatsSynced: number;
  cleaned: number;
}

/**
 * 定期ジョブ（1時間ごとに実行してよい。いずれも繰り返しても結果が変わらない）。
 *  - 無料トライアル終了の案内メール（1社1回）
 *  - 座席数が Stripe に反映できていない会社の再同期
 *  - 期限切れのセッション・パスワード再設定・メール確認トークンの削除
 */
export async function runJobs(d: JobDeps, opts: { fullSeatReconcile?: boolean } = {}): Promise<JobSummary> {
  const out: JobSummary = { reminders: 0, seatsSynced: 0, cleaned: 0 };
  for (const t of d.manager.list()) {
    const now = d.clockFor(t.tz).now().ts;
    const db = d.manager.db(t.id);

    // メールアドレスが未確認の会社には送らない
    if (t.status === "trialing" && t.adminEmailVerifiedAt && t.trialReminderSentAt === undefined && t.trialEndsAt > now && t.trialEndsAt - now <= TRIAL_REMINDER_DAYS * DAY) {
      const admin = db.prepare("SELECT name FROM employees WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get() as { name: string } | undefined;
      const daysLeft = Math.max(1, Math.ceil((t.trialEndsAt - now) / DAY));
      const mail = templates.trialEnding({ adminName: admin?.name ?? "ご担当者", daysLeft, billingUrl: d.appUrl ? `${d.appUrl}/app/#/billing` : "（管理画面の「請求」から）" });
      try {
        await d.mailer.send({ to: t.adminEmail, ...mail });
        d.manager.update(t.id, { trialReminderSentAt: now });
        out.reminders++;
      } catch (e) {
        console.error(`トライアル終了の案内メールを送れませんでした（${t.code}）:`, e instanceof Error ? e.message : e);
      }
    }

    if (d.billing.configured && t.stripeItemId && t.status !== "canceled") {
      if (t.seatsDirty) {
        await syncSeats(d.manager, d.billing, t.id, db);
        out.seatsSynced++;
      } else if (opts.fullSeatReconcile) {
        try {
          if ((await d.billing.getSeats({ itemId: t.stripeItemId })) !== Math.max(1, activeCount(db))) {
            await syncSeats(d.manager, d.billing, t.id, db);
            out.seatsSynced++;
          }
        } catch (e) {
          console.error(`座席数の照合に失敗しました（${t.code}）:`, e instanceof Error ? e.message : e);
        }
      }
    }

    out.cleaned += Number(db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now).changes);
    // 集計の差分更新のための変更の記録。新しい2万件だけ残す（欠けていたら、集計は作り直される）
    out.cleaned += Number(db.prepare("DELETE FROM data_changes WHERE id <= (SELECT MAX(id) FROM data_changes) - 20000").run().changes);
    out.cleaned += Number(db.prepare("DELETE FROM kiosk_tickets WHERE expires_at < ?").run(now).changes);
    out.cleaned += Number(db.prepare("DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL").run(now - DAY).changes);
  }
  out.cleaned += d.manager.cleanEmailVerifications(d.clockFor("Asia/Tokyo").now().ts, DAY);
  return out;
}
