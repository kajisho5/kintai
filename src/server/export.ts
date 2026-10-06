import type { Tenant } from "./control";
import type { Db } from "./db";

/**
 * 会社のデータをすべて JSON にまとめる（契約者の書き出し・解約時・運用での引き渡し用）。
 * パスワードのハッシュとセッションは含めない。
 */
export function exportCompany(db: Db, tenant: Pick<Tenant, "code" | "name">, nowMs: number): Record<string, unknown> {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    exportedAt: new Date(nowMs).toISOString(),
    company: { code: tenant.code, name: tenant.name },
    note: "時刻（min）は、その日の0:00からの経過分です。",
    settings: all("SELECT key, value FROM settings ORDER BY key"),
    employees: all(
      "SELECT id, name, dept, title, kind, role, email, work_days AS workDays, weekly_days AS weeklyDays, weekly_hours AS weeklyHours, base_min AS baseMin, sched_start AS schedStart, hired, left_on AS leftOn, carry, active FROM employees ORDER BY id",
    ),
    punchEvents: all("SELECT seq, emp_id AS empId, date, kind, min, source, created_at AS createdAt FROM punch_events ORDER BY seq"),
    paidLeave: all("SELECT emp_id AS empId, date, days FROM paid_leave ORDER BY date, emp_id"),
    requests: all("SELECT id, emp_id AS empId, kind, date, payload, reason, status, created_at AS createdAt, decided_by AS decidedBy, decided_at AS decidedAt FROM requests ORDER BY id"),
    holidays: all("SELECT date, name, kind FROM holidays ORDER BY date"),
    auditLog: all("SELECT id, at, actor, action, detail FROM audit_log ORDER BY id"),
  };
}
