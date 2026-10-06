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
  {
    id: 4,
    name: "password_resets",
    sql: `
      CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        emp_id TEXT NOT NULL REFERENCES employees(id),
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `,
  },
  {
    id: 5,
    name: "work_styles_and_schedules",
    sql: `
      -- 勤務区分: fixed=通常 / monthly=1か月単位の変形 / yearly=1年単位の変形 / weekly=1週間単位の変形 / flex=フレックス
      ALTER TABLE employees ADD COLUMN work_style TEXT NOT NULL DEFAULT 'fixed' CHECK (work_style IN ('fixed','monthly','yearly','weekly','flex'));
      -- シフト（勤務予定）。work=勤務 / off=休み / legal_off=法定休日（週1回の休日として指定した日）
      CREATE TABLE schedules (
        emp_id TEXT NOT NULL REFERENCES employees(id),
        date TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('work','off','legal_off')),
        start INTEGER,
        end INTEGER,
        break_min INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (emp_id, date),
        CHECK (kind <> 'work' OR (start IS NOT NULL AND end IS NOT NULL AND end > start AND start >= 0 AND end <= 2880 AND break_min >= 0 AND break_min < end - start))
      );
      CREATE INDEX idx_schedules_date ON schedules (date);
    `,
  },
  {
    id: 6,
    name: "geo_and_kiosk",
    sql: `
      -- 位置情報つき打刻: geo は 'in'=打刻場所の範囲内 / 'out'=範囲外 / 'unknown'=位置情報なし
      ALTER TABLE punch_events ADD COLUMN lat REAL;
      ALTER TABLE punch_events ADD COLUMN lng REAL;
      ALTER TABLE punch_events ADD COLUMN accuracy REAL;
      ALTER TABLE punch_events ADD COLUMN geo TEXT CHECK (geo IN ('in','out','unknown'));
      ALTER TABLE employees ADD COLUMN geo_exempt INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE geo_sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
        lng REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
        radius_m INTEGER NOT NULL CHECK (radius_m BETWEEN 10 AND 5000)
      );

      -- 共用の打刻端末（タブレットなど）。token_hash は端末のトークンのハッシュ
      ALTER TABLE employees ADD COLUMN punch_pin_hash TEXT;
      ALTER TABLE employees ADD COLUMN card_hash TEXT;
      CREATE UNIQUE INDEX idx_employees_card ON employees (card_hash) WHERE card_hash IS NOT NULL;
      CREATE TABLE kiosk_terminals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE kiosk_tickets (
        token_hash TEXT PRIMARY KEY,
        emp_id TEXT NOT NULL REFERENCES employees(id),
        terminal_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
  },
];

export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number[] {
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
