import type { DatabaseSync } from "node:sqlite";

/**
 * 顧客（テナント）ごとの DB のスキーマ変更履歴。
 * 既存の履歴は書き換えず、末尾に追加する。各テナント DB は開くときに未適用ぶんが自動で適用される。
 */
export const BASELINE_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dept TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('正社員','パート')),
  role TEXT NOT NULL CHECK (role IN ('admin','employee')),
  work_days TEXT NOT NULL,
  weekly_days INTEGER NOT NULL,
  weekly_hours REAL NOT NULL,
  base_min INTEGER NOT NULL,
  sched_start INTEGER NOT NULL,
  hired TEXT NOT NULL,
  carry REAL NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  emp_id TEXT NOT NULL REFERENCES employees(id),
  expires_at INTEGER NOT NULL
);

-- 打刻は追記のみ。修正は source='correction' のイベントを追加して上書きする
CREATE TABLE IF NOT EXISTS punch_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_id TEXT NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('in','out','break_start','break_end')),
  min INTEGER NOT NULL CHECK (min >= 0 AND min < 2880),
  source TEXT NOT NULL DEFAULT 'punch',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_punch_emp_date ON punch_events (emp_id, date);
CREATE INDEX IF NOT EXISTS idx_punch_date ON punch_events (date);

CREATE TABLE IF NOT EXISTS paid_leave (
  emp_id TEXT NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,
  days REAL NOT NULL CHECK (days IN (0.5, 1)),
  PRIMARY KEY (emp_id, date)
);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_id TEXT NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL CHECK (kind IN ('残業申請','休日出勤','有給申請','打刻修正')),
  date TEXT NOT NULL,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;


interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { id: 1, name: "baseline", sql: BASELINE_SQL },
  {
    id: 2,
    name: "saas_columns",
    sql: `
      ALTER TABLE employees ADD COLUMN email TEXT;
      ALTER TABLE employees ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE holidays ADD COLUMN kind TEXT NOT NULL DEFAULT 'national';
    `,
  },
  // 退職日。退職後も、在籍していた月の勤怠は一覧に残す
  { id: 3, name: "employee_left_on", sql: "ALTER TABLE employees ADD COLUMN left_on TEXT;" },
];

export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const done = new Set((db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id));
  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, Date.now());
      db.exec("COMMIT");
      applied.push(m.id);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`マイグレーション ${m.id}（${m.name}）に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return applied;
}
