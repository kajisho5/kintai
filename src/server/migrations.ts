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
  {
    id: 7,
    name: "audit_index",
    sql: `
      CREATE INDEX idx_audit_action ON audit_log (action, id);
      CREATE INDEX idx_audit_actor ON audit_log (actor, id);
    `,
  },
  {
    id: 8,
    name: "two_factor",
    sql: `
      -- 二段階認証（TOTP）。totp_secret は暗号化した秘密鍵。totp_pending は設定の途中（まだ有効でない）の秘密鍵
      ALTER TABLE employees ADD COLUMN totp_secret TEXT;
      ALTER TABLE employees ADD COLUMN totp_pending TEXT;
      ALTER TABLE employees ADD COLUMN totp_enabled_at INTEGER;
      ALTER TABLE employees ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE employees ADD COLUMN totp_recovery TEXT;
    `,
  },
  {
    id: 9,
    name: "data_revisions",
    sql: `
      -- 集計（Ledger）の元になる表の変更回数。打刻以外の表が変わったら、集計を作り直す（打刻は、追記のみなので、増えた分だけを加える）
      CREATE TABLE data_rev (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
      INSERT INTO data_rev (name, n) VALUES ('employees', 0), ('settings', 0), ('holidays', 0), ('schedules', 0), ('paid_leave', 0);
      CREATE TRIGGER rev_employees_i AFTER INSERT ON employees BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'employees'; END;
      CREATE TRIGGER rev_employees_u AFTER UPDATE OF name, dept, title, kind, role, work_style, geo_exempt, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, carry, email, must_change_password, left_on, active ON employees BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'employees'; END;
      CREATE TRIGGER rev_employees_d AFTER DELETE ON employees BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'employees'; END;
      CREATE TRIGGER rev_settings_i AFTER INSERT ON settings BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'settings'; END;
      CREATE TRIGGER rev_settings_u AFTER UPDATE ON settings BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'settings'; END;
      CREATE TRIGGER rev_settings_d AFTER DELETE ON settings BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'settings'; END;
      CREATE TRIGGER rev_holidays_i AFTER INSERT ON holidays BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'holidays'; END;
      CREATE TRIGGER rev_holidays_u AFTER UPDATE ON holidays BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'holidays'; END;
      CREATE TRIGGER rev_holidays_d AFTER DELETE ON holidays BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'holidays'; END;
      CREATE TRIGGER rev_schedules_i AFTER INSERT ON schedules BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'schedules'; END;
      CREATE TRIGGER rev_schedules_u AFTER UPDATE ON schedules BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'schedules'; END;
      CREATE TRIGGER rev_schedules_d AFTER DELETE ON schedules BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'schedules'; END;
      CREATE TRIGGER rev_paid_leave_i AFTER INSERT ON paid_leave BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'paid_leave'; END;
      CREATE TRIGGER rev_paid_leave_u AFTER UPDATE ON paid_leave BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'paid_leave'; END;
      CREATE TRIGGER rev_paid_leave_d AFTER DELETE ON paid_leave BEGIN UPDATE data_rev SET n = n + 1 WHERE name = 'paid_leave'; END;
    `,
  },
  {
    id: 10,
    name: "data_changes",
    sql: `
      -- 社員・シフト・有給の変更は、変更した社員だけを記録する（集計を、その社員の分だけ作り直せるように）。設定・祝日は、data_rev の回数で検知する
      DROP TRIGGER rev_employees_i;
      DROP TRIGGER rev_employees_u;
      DROP TRIGGER rev_employees_d;
      DROP TRIGGER rev_schedules_i;
      DROP TRIGGER rev_schedules_u;
      DROP TRIGGER rev_schedules_d;
      DROP TRIGGER rev_paid_leave_i;
      DROP TRIGGER rev_paid_leave_u;
      DROP TRIGGER rev_paid_leave_d;
      CREATE TABLE data_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, emp_id TEXT NOT NULL);
      CREATE TRIGGER chg_employees_i AFTER INSERT ON employees BEGIN INSERT INTO data_changes (tbl, emp_id) VALUES ('employees', NEW.id); END;
      CREATE TRIGGER chg_employees_u AFTER UPDATE OF name, dept, title, kind, role, work_style, geo_exempt, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, carry, email, must_change_password, left_on, active, id ON employees BEGIN INSERT INTO data_changes (tbl, emp_id) VALUES ('employees', NEW.id); INSERT INTO data_changes (tbl, emp_id) VALUES ('employees', OLD.id); END;
      CREATE TRIGGER chg_employees_d AFTER DELETE ON employees BEGIN INSERT INTO data_changes (tbl, emp_id) VALUES ('employees', OLD.id); END;
      CREATE TRIGGER chg_schedules_i AFTER INSERT ON schedules BEGIN INSERT INTO data_changes (tbl, emp_id) VALUES ('schedules', NEW.emp_id); END;
      CREATE TRIGGER chg_schedules_u AFTER UPDATE ON schedules BEGIN INSERT INTO data_changes (tbl, emp_id) VALUES ('schedules', NEW.emp_id); INSERT INTO data_changes (tbl, emp_id) VALUES ('schedules', OLD.emp_id); END;
      CREATE TRIGGER chg_schedules_d AFTER DELETE ON schedules BEGIN INSERT INTO data_changes (tbl, emp_id) VALUES ('schedules', OLD.emp_id); END;
      CREATE TRIGGER chg_paid_leave_i AFTER INSERT ON paid_leave BEGIN INSERT INTO data_changes (tbl, emp_id) VALUES ('paid_leave', NEW.emp_id); END;
      CREATE TRIGGER chg_paid_leave_u AFTER UPDATE ON paid_leave BEGIN INSERT INTO data_changes (tbl, emp_id) VALUES ('paid_leave', NEW.emp_id); INSERT INTO data_changes (tbl, emp_id) VALUES ('paid_leave', OLD.emp_id); END;
      CREATE TRIGGER chg_paid_leave_d AFTER DELETE ON paid_leave BEGIN INSERT INTO data_changes (tbl, emp_id) VALUES ('paid_leave', OLD.emp_id); END;
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
