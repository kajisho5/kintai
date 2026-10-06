import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
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

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function audit(db: Db, at: number, actor: string, action: string, detail: unknown): void {
  db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)").run(at, actor, action, JSON.stringify(detail));
}
