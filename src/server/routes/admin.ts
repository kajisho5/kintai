import { randomInt } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { HOLIDAYS_JP_LAST_YEAR } from "../../domain/holidays-jp";
import { isDate, type EmployeeAdmin, type EmployeesResponse, type ImportResponse, type ImportRowError, type SettingsResponse } from "../../domain";
import { hashPassword } from "../auth";
import { activeCount, ApiError, parse, requireAdmin, type Env } from "../context";
import { audit, tx, type Db } from "../db";
import { parseCsv } from "../csv";
import { exportCompany } from "../export";
import { loadSettings } from "../repo";
import { syncSeats } from "../seats";
import type { Deps } from "./auth";

// 紛らわしい文字（0/O, 1/l/I）を除いた一時パスワード用の文字集合
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export const tempPassword = (): string => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]!).join("");

const WEEKDAY_CHARS = "日月火水木金土";

interface EmpRow {
  id: string;
  name: string;
  dept: string;
  title: string;
  kind: "正社員" | "パート";
  role: "admin" | "employee";
  email: string | null;
  work_days: string;
  weekly_days: number;
  weekly_hours: number;
  base_min: number;
  sched_start: number;
  hired: string;
  carry: number;
  active: number;
  must_change_password: number;
  left_on: string | null;
}

const toAdminView = (r: EmpRow): EmployeeAdmin => ({
  id: r.id,
  name: r.name,
  dept: r.dept,
  title: r.title,
  kind: r.kind,
  role: r.role,
  email: r.email ?? undefined,
  workDays: JSON.parse(r.work_days) as number[],
  weeklyDays: r.weekly_days,
  weeklyHours: r.weekly_hours,
  baseMin: r.base_min,
  schedStart: r.sched_start,
  hired: r.hired,
  carry: r.carry,
  active: r.active === 1,
  mustChangePassword: r.must_change_password === 1,
  leftOn: r.left_on ?? undefined,
});

// ---------------------------------------------------------------- 入力の検証

const idStr = z.string().trim().regex(/^[A-Za-z0-9._-]{1,30}$/, "社員IDは半角英数字と . _ - の30文字以内で入力してください");
const dateStr = z.string().refine(isDate, "日付の形式が正しくありません（例: 2026-04-01）");
const weekdays = z
  .array(z.number().int().min(0).max(6))
  .min(1, "所定労働日を1日以上選んでください")
  .max(7)
  .transform((a) => [...new Set(a)].sort());

const carryNum = z.number().min(0, "繰越は0以上にしてください").max(40, "繰越は40日以内にしてください").multipleOf(0.5, "繰越は0.5日単位で入力してください");

const fields = {
  name: z.string().trim().min(1, "氏名を入力してください").max(40, "氏名は40文字以内で入力してください"),
  dept: z.string().trim().min(1, "部署を入力してください").max(30, "部署は30文字以内で入力してください"),
  title: z.string().trim().max(20, "役職は20文字以内で入力してください").default(""),
  kind: z.enum(["正社員", "パート"], "雇用区分は「正社員」か「パート」にしてください"),
  role: z.enum(["admin", "employee"]).default("employee"),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(120)
    .refine((v) => v === "" || z.email().safeParse(v).success, "メールアドレスの形式が正しくありません")
    .optional(),
  workDays: weekdays,
  baseMin: z.number().int().min(60, "所定労働時間は1時間以上にしてください").max(720, "所定労働時間は12時間以内にしてください"),
  weeklyDays: z.number().int().min(1).max(7).optional(),
  weeklyHours: z.number().min(1).max(80).optional(),
  schedStart: z.number().int().min(0).max(1439),
  hired: dateStr,
  carry: carryNum.default(0),
};

const createSchema = z.object({ id: idStr, ...fields, password: z.string().min(8, "パスワードは8文字以上にしてください").max(200).optional() });
const patchSchema = z.object({
  name: fields.name.optional(),
  dept: fields.dept.optional(),
  title: z.string().trim().max(20).optional(),
  kind: fields.kind.optional(),
  role: z.enum(["admin", "employee"]).optional(),
  email: fields.email,
  workDays: weekdays.optional(),
  baseMin: fields.baseMin.optional(),
  weeklyDays: fields.weeklyDays,
  weeklyHours: fields.weeklyHours,
  schedStart: fields.schedStart.optional(),
  hired: dateStr.optional(),
  // 更新では、指定のない項目は変更しない（default を持つ fields.carry は使わない）
  carry: carryNum.optional(),
});

type Created = z.infer<typeof createSchema>;

function defaults(e: Pick<Created, "workDays" | "baseMin" | "weeklyDays" | "weeklyHours">) {
  const weeklyDays = e.weeklyDays ?? e.workDays.length;
  const weeklyHours = e.weeklyHours ?? Math.round(((weeklyDays * e.baseMin) / 60) * 10) / 10;
  return { weeklyDays, weeklyHours };
}

/** password は、すでにハッシュ化したもの（重い計算はトランザクションの外・非同期で行うため） */
function insertEmployee(db: Db, e: Created, passwordHash: string, mustChange: boolean): void {
  const { weeklyDays, weeklyHours } = defaults(e);
  db.prepare(
    `INSERT INTO employees (id, name, dept, title, kind, role, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, carry, password_hash, email, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.id, e.name, e.dept, e.title, e.kind, e.role, JSON.stringify(e.workDays), weeklyDays, weeklyHours, e.baseMin, e.schedStart, e.hired, e.carry, passwordHash, e.email || null, mustChange ? 1 : 0);
}

const activeAdmins = (db: Db): number => (db.prepare("SELECT COUNT(*) AS n FROM employees WHERE active = 1 AND role = 'admin'").get() as { n: number }).n;

// ---------------------------------------------------------------- CSV 取り込み

export const CSV_HEADERS = ["社員ID", "氏名", "部署", "役職", "雇用区分", "権限", "メール", "入社日", "所定労働日", "所定労働時間", "始業時刻", "繰越有給"] as const;
const REQUIRED = ["社員ID", "氏名", "部署", "入社日"] as const;
const MAX_IMPORT_ROWS = 500;

function parseWeekdays(s: string): number[] | string {
  const chars = [...s.replace(/[\s・,、]/g, "")];
  if (!chars.length) return [1, 2, 3, 4, 5];
  const out: number[] = [];
  for (const ch of chars) {
    const i = WEEKDAY_CHARS.indexOf(ch);
    if (i < 0) return `所定労働日「${s}」は「月火水木金」のように曜日の文字で指定してください`;
    out.push(i);
  }
  return out;
}

function parseHm(s: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) <= 23 && Number(m[2]) <= 59 ? v : undefined;
}

function parseDate(s: string): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s.trim());
  return m ? `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}` : s.trim();
}

export function parseEmployeeCsv(text: string, existingIds: Set<string>): { rows: { line: number; data: Created }[]; errors: ImportRowError[] } {
  const table = parseCsv(text);
  const errors: ImportRowError[] = [];
  if (!table.length) return { rows: [], errors: [{ row: 1, message: "CSVが空です" }] };
  const header = table[0]!.map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const missing = REQUIRED.filter((h) => col(h) < 0);
  if (missing.length) return { rows: [], errors: [{ row: 1, message: `見出し行に ${missing.join("・")} がありません。テンプレートの見出しをそのまま使ってください` }] };
  if (table.length - 1 > MAX_IMPORT_ROWS) return { rows: [], errors: [{ row: 1, message: `一度に取り込めるのは${MAX_IMPORT_ROWS}名までです` }] };

  const rows: { line: number; data: Created }[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (name: string) => (col(name) >= 0 ? (cells[col(name)] ?? "").trim() : "");
    const fail = (message: string) => errors.push({ row: line, message });

    const days = parseWeekdays(get("所定労働日"));
    if (typeof days === "string") return fail(days);
    const kindRaw = get("雇用区分") || "正社員";
    const hoursRaw = get("所定労働時間");
    const hours = hoursRaw ? Number(hoursRaw) : kindRaw === "パート" ? 6 : 8;
    if (!Number.isFinite(hours)) return fail(`所定労働時間「${hoursRaw}」は数字（時間）で入力してください`);
    const start = get("始業時刻") ? parseHm(get("始業時刻")) : 540;
    if (start === undefined) return fail(`始業時刻「${get("始業時刻")}」は 9:00 の形式で入力してください`);
    const roleRaw = get("権限");
    if (roleRaw && !["管理者", "一般"].includes(roleRaw)) return fail(`権限「${roleRaw}」は「管理者」か「一般」にしてください`);
    const carryRaw = get("繰越有給");

    const r = createSchema.omit({ password: true }).safeParse({
      id: get("社員ID"),
      name: get("氏名"),
      dept: get("部署"),
      title: get("役職"),
      kind: kindRaw,
      role: roleRaw === "管理者" ? "admin" : "employee",
      email: get("メール"),
      workDays: days,
      baseMin: Math.round(hours * 60),
      schedStart: start,
      hired: parseDate(get("入社日")),
      carry: carryRaw ? Number(carryRaw) : 0,
    });
    if (!r.success) return fail(r.error.issues[0]?.message ?? "入力が正しくありません");
    if (existingIds.has(r.data.id)) return fail(`社員ID「${r.data.id}」はすでに登録されています`);
    if (seen.has(r.data.id)) return fail(`社員ID「${r.data.id}」がCSV内で重複しています`);
    seen.add(r.data.id);
    rows.push({ line, data: r.data as Created });
  });
  return { rows, errors };
}

// ---------------------------------------------------------------- ルート

export function adminRoutes({ manager, billing }: Deps): Hono<Env> {
  const app = new Hono<Env>();

  const list = (db: Db): EmployeesResponse["rows"] =>
    (db.prepare("SELECT * FROM employees ORDER BY active DESC, id").all() as unknown as EmpRow[]).map(toAdminView);

  const seatCheck = (c: Context<Env>, adding: number): void => {
    const limit = c.get("access").seatLimit;
    if (activeCount(c.get("db")) + adding > limit) {
      throw new ApiError(409, `ご契約の人数（${limit}名）を超えるため追加できません`, "SEAT_LIMIT");
    }
  };

  /** 人数が変わったら、契約中なら課金の数量に反映する（失敗しても操作は止めない） */
  const seatsChanged = (c: Context<Env>): void => {
    void syncSeats(manager, billing, c.get("tenant").id, c.get("db"));
  };

  const target = (c: Context<Env>): EmpRow => {
    const row = c.get("db").prepare("SELECT * FROM employees WHERE id = ?").get(c.req.param("id") ?? "") as unknown as EmpRow | undefined;
    if (!row) throw new ApiError(404, "社員が見つかりません");
    return row;
  };

  app.get("/api/employees", (c) => {
    requireAdmin(c);
    const rows = list(c.get("db"));
    const body: EmployeesResponse = { rows, seatsUsed: rows.filter((r) => r.active).length, seatLimit: c.get("access").seatLimit };
    return c.json(body);
  });

  app.post("/api/employees", async (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const e = parse(createSchema, await c.req.json().catch(() => null));
    seatCheck(c, 1);
    if (db.prepare("SELECT 1 FROM employees WHERE id = ?").get(e.id)) throw new ApiError(409, `社員ID「${e.id}」はすでに使われています`);
    // 管理者が決めたパスワードも、初回ログイン時に本人が変更する
    const pw = e.password ?? tempPassword();
    const pwHash = await hashPassword(pw);
    // 非同期の計算のあいだに状況が変わりうるため、登録の直前（同期処理の中）でもう一度確認する
    seatCheck(c, 1);
    try {
      insertEmployee(db, e, pwHash, true);
    } catch (err) {
      if (err instanceof Error && /UNIQUE|PRIMARY/i.test(err.message)) throw new ApiError(409, `社員ID「${e.id}」はすでに使われています`);
      throw err;
    }
    audit(db, c.get("clock").now().ts, admin.id, "employee_create", { id: e.id, role: e.role });
    seatsChanged(c);
    return c.json({ id: e.id, tempPassword: pw }, 201);
  });

  app.patch("/api/employees/:id", async (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const cur = target(c);
    const p = parse(patchSchema, await c.req.json().catch(() => null));
    if (p.role === "employee" && cur.role === "admin" && cur.active === 1 && activeAdmins(db) <= 1) {
      throw new ApiError(409, "管理者が1人もいなくなるため、権限は変更できません");
    }
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null | undefined) => {
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(v);
      }
    };
    set("name", p.name);
    set("dept", p.dept);
    set("title", p.title);
    set("kind", p.kind);
    set("role", p.role);
    if (p.email !== undefined) set("email", p.email || null);
    if (p.workDays) set("work_days", JSON.stringify(p.workDays));
    set("base_min", p.baseMin);
    set("sched_start", p.schedStart);
    set("hired", p.hired);
    set("carry", p.carry);
    // 所定の日数・時間を変えたら、週あたりの値も合わせて更新する（明示指定があればそれを優先）
    if (p.workDays || p.baseMin || p.weeklyDays || p.weeklyHours) {
      const days = p.workDays ?? (JSON.parse(cur.work_days) as number[]);
      const d = defaults({ workDays: days, baseMin: p.baseMin ?? cur.base_min, weeklyDays: p.weeklyDays, weeklyHours: p.weeklyHours });
      set("weekly_days", d.weeklyDays);
      set("weekly_hours", d.weeklyHours);
    }
    if (!sets.length) throw new ApiError(400, "変更する項目がありません");
    db.prepare(`UPDATE employees SET ${sets.join(", ")} WHERE id = ?`).run(...vals, cur.id);
    if (p.role !== undefined && p.role !== cur.role) db.prepare("DELETE FROM sessions WHERE emp_id = ?").run(cur.id);
    audit(db, c.get("clock").now().ts, admin.id, "employee_update", { id: cur.id, fields: Object.keys(p) });
    return c.json({ ok: true });
  });

  app.post("/api/employees/:id/reset-password", async (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const cur = target(c);
    if (cur.id === admin.id) throw new ApiError(400, "自分のパスワードは、画面左下の鍵のボタンから変更してください");
    const pw = tempPassword();
    const pwHash = await hashPassword(pw);
    db.prepare("UPDATE employees SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(pwHash, cur.id);
    db.prepare("DELETE FROM sessions WHERE emp_id = ?").run(cur.id);
    audit(db, c.get("clock").now().ts, admin.id, "employee_reset_password", { id: cur.id });
    return c.json({ id: cur.id, tempPassword: pw });
  });

  app.post("/api/employees/:id/deactivate", (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const cur = target(c);
    if (cur.id === admin.id) throw new ApiError(400, "自分自身は退職処理できません");
    if (cur.active !== 1) throw new ApiError(409, "すでに退職扱いです");
    if (cur.role === "admin" && activeAdmins(db) <= 1) throw new ApiError(409, "最後の管理者は退職処理できません");
    tx(db, () => {
      db.prepare("UPDATE employees SET active = 0, left_on = ? WHERE id = ?").run(c.get("clock").now().date, cur.id);
      db.prepare("DELETE FROM sessions WHERE emp_id = ?").run(cur.id);
      // 未処理の申請は取り下げ扱いにする
      db.prepare("UPDATE requests SET status = 'cancelled' WHERE emp_id = ? AND status = 'pending'").run(cur.id);
    });
    audit(db, c.get("clock").now().ts, admin.id, "employee_deactivate", { id: cur.id });
    seatsChanged(c);
    return c.json({ ok: true });
  });

  app.post("/api/employees/:id/reactivate", (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const cur = target(c);
    if (cur.active === 1) throw new ApiError(409, "すでに在籍中です");
    seatCheck(c, 1);
    db.prepare("UPDATE employees SET active = 1, left_on = NULL WHERE id = ?").run(cur.id);
    audit(db, c.get("clock").now().ts, admin.id, "employee_reactivate", { id: cur.id });
    seatsChanged(c);
    return c.json({ ok: true });
  });

  app.post("/api/employees/import", async (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const body = parse(z.object({ csv: z.string().max(2_000_000), dryRun: z.boolean().default(false) }), await c.req.json().catch(() => null));
    const existing = new Set((db.prepare("SELECT id FROM employees").all() as { id: string }[]).map((r) => r.id));
    const { rows, errors } = parseEmployeeCsv(body.csv, existing);
    const limit = c.get("access").seatLimit;
    if (!errors.length && activeCount(db) + rows.length > limit) {
      errors.push({ row: 1, message: `取り込むとご契約の人数（${limit}名）を超えます（現在${activeCount(db)}名 + ${rows.length}名）` });
    }
    if (errors.length) return c.json({ ok: false, errors } satisfies ImportResponse);
    if (body.dryRun) return c.json({ ok: true, dryRun: true, count: rows.length } satisfies ImportResponse);

    const credentials = rows.map(({ data }) => ({ id: data.id, name: data.name, tempPassword: tempPassword() }));
    const hashes = await Promise.all(credentials.map((c) => hashPassword(c.tempPassword))); // 同時に計算してもイベントループは止まらない
    if (activeCount(db) + rows.length > limit) throw new ApiError(409, `ご契約の人数（${limit}名）を超えるため取り込めません`, "SEAT_LIMIT");
    try {
      tx(db, () => rows.forEach(({ data }, i) => insertEmployee(db, data, hashes[i]!, true)));
    } catch (err) {
      if (err instanceof Error && /UNIQUE|PRIMARY/i.test(err.message)) throw new ApiError(409, "同じ社員IDがすでに登録されています。もう一度、最初から取り込み直してください");
      throw err;
    }
    audit(db, c.get("clock").now().ts, admin.id, "employee_import", { count: rows.length });
    seatsChanged(c);
    return c.json({ ok: true, dryRun: false, count: rows.length, credentials } satisfies ImportResponse);
  });

  // ---- データの書き出し（解約後・閲覧のみの状態でも使える） ----

  app.get("/api/export", (c) => {
    requireAdmin(c);
    const now = c.get("clock").now();
    const body = JSON.stringify(exportCompany(c.get("db"), c.get("tenant"), now.ts), null, 2);
    audit(c.get("db"), now.ts, c.get("me").id, "export", {});
    return c.body(body, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="export-${c.get("tenant").code}-${now.date}.json"`,
    });
  });

  // ---- 会社設定 ----

  const settingsView = (c: Context<Env>): SettingsResponse => {
    const db = c.get("db");
    const s = loadSettings(db);
    const year = Number(c.get("clock").now().date.slice(0, 4));
    const month = Number(c.get("clock").now().date.slice(5, 7));
    return {
      company: { name: c.get("tenant").name, code: c.get("tenant").code },
      specialClause: s.specialClause,
      fyStartMonth: s.fyStartMonth,
      holidays: db.prepare("SELECT date, name, kind FROM holidays WHERE date >= ? ORDER BY date").all(`${year - 1}-01-01`) as unknown as SettingsResponse["holidays"],
      holidaysStale: year > HOLIDAYS_JP_LAST_YEAR || (year === HOLIDAYS_JP_LAST_YEAR && month >= 10),
    };
  };

  app.get("/api/settings", (c) => {
    requireAdmin(c);
    return c.json(settingsView(c));
  });

  app.patch("/api/settings", async (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const p = parse(
      z.object({ name: z.string().trim().min(1, "会社名を入力してください").max(60).optional(), specialClause: z.boolean().optional(), fyStartMonth: z.number().int().min(1).max(12).optional() }),
      await c.req.json().catch(() => null),
    );
    const put = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    if (p.specialClause !== undefined) put.run("special_clause", p.specialClause ? "1" : "0");
    if (p.fyStartMonth !== undefined) put.run("fy_start_month", String(p.fyStartMonth));
    if (p.name !== undefined) manager.update(c.get("tenant").id, { name: p.name });
    audit(db, c.get("clock").now().ts, admin.id, "settings_update", p);
    return c.json({ ...settingsView(c), company: { name: p.name ?? c.get("tenant").name, code: c.get("tenant").code } });
  });

  app.post("/api/settings/holidays", async (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const h = parse(z.object({ date: dateStr, name: z.string().trim().min(1, "名称を入力してください").max(30, "名称は30文字以内にしてください") }), await c.req.json().catch(() => null));
    db.prepare("INSERT OR REPLACE INTO holidays (date, name, kind) VALUES (?, ?, 'company')").run(h.date, h.name);
    audit(db, c.get("clock").now().ts, admin.id, "holiday_add", h);
    return c.json({ ok: true }, 201);
  });

  app.delete("/api/settings/holidays/:date", (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const date = c.req.param("date");
    if (!isDate(date)) throw new ApiError(400, "日付の形式が正しくありません");
    const r = db.prepare("DELETE FROM holidays WHERE date = ?").run(date);
    if (!r.changes) throw new ApiError(404, "その日の休日は登録されていません");
    audit(db, c.get("clock").now().ts, admin.id, "holiday_remove", { date });
    return c.json({ ok: true });
  });

  return app;
}
