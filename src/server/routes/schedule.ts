import { Hono } from "hono";
import { z } from "zod";
import { addDays, addYm, isDate, isYm, lastDateOfMonth, type ImportRowError, type ScheduleImportResponse, type ScheduleItem, type ScheduleResponse, type WorkStyle } from "../../domain";
import { ApiError, brief, parse, requireAdmin, type Env } from "../context";
import { parseCsv } from "../csv";
import { audit, tx, type Db } from "../db";
import { loadEmployees } from "../repo";

const MAX_ITEMS = 1000;
const MAX_IMPORT_ROWS = 3000;

const itemSchema = z.discriminatedUnion("kind", [
  z.object({
    empId: z.string().min(1).max(30),
    date: z.string().refine(isDate, "日付の形式が正しくありません"),
    kind: z.literal("work"),
    start: z.number().int().min(0).max(2879),
    end: z.number().int().min(1).max(2880),
    breakMin: z.number().int().min(0).max(600),
  }),
  z.object({ empId: z.string().min(1).max(30), date: z.string().refine(isDate, "日付の形式が正しくありません"), kind: z.enum(["off", "legal_off", "clear"]) }),
]);

/** 勤務の時間の妥当性。開始は終了より前、休憩は勤務時間より短く、1日の勤務は24時間以内 */
function checkWork(i: Extract<ScheduleItem, { kind: "work" }>): string | undefined {
  if (i.end <= i.start) return "終了は開始より後にしてください";
  if (i.end - i.start > 24 * 60) return "1日の勤務は24時間以内にしてください";
  if (i.breakMin >= i.end - i.start) return "休憩は勤務時間より短くしてください";
  return undefined;
}

/** 時刻 "9:00" "25:30"（翌日は24時以降。47:59 まで）→ 分 */
function parseHm(s: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) <= 59 && v < 2880 ? v : undefined;
}

const KIND_BY_LABEL: Record<string, "work" | "off" | "legal_off" | "clear"> = { 勤務: "work", 休み: "off", 法定休日: "legal_off", 削除: "clear" };

function parseDateLoose(s: string): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s.trim());
  return m ? `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}` : s.trim();
}

export function parseScheduleCsv(text: string): { items: ScheduleItem[]; errors: ImportRowError[] } {
  const table = parseCsv(text);
  const errors: ImportRowError[] = [];
  if (!table.length) return { items: [], errors: [{ row: 1, message: "CSVが空です" }] };
  const header = table[0]!.map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const missing = ["社員ID", "日付", "区分"].filter((h) => col(h) < 0);
  if (missing.length) return { items: [], errors: [{ row: 1, message: `見出し行に ${missing.join("・")} がありません。テンプレートの見出しをそのまま使ってください` }] };
  if (table.length - 1 > MAX_IMPORT_ROWS) return { items: [], errors: [{ row: 1, message: `一度に取り込めるのは${MAX_IMPORT_ROWS}行までです` }] };

  const items: ScheduleItem[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((cells, idx) => {
    const row = idx + 2;
    const get = (name: string) => (col(name) >= 0 ? (cells[col(name)] ?? "").trim() : "");
    const fail = (message: string) => errors.push({ row, message });
    const empId = get("社員ID");
    const date = parseDateLoose(get("日付"));
    const label = get("区分");
    if (!empId) return fail("社員IDを入力してください");
    if (!isDate(date)) return fail(`日付「${get("日付")}」の形式が正しくありません（例: 2026-10-05）`);
    const kind = KIND_BY_LABEL[label];
    if (!kind) return fail(`区分「${label}」は「${Object.keys(KIND_BY_LABEL).join("・")}」のいずれかにしてください`);
    const key = `${empId}|${date}`;
    if (seen.has(key)) return fail(`${empId} の ${date} がCSV内で重複しています`);
    seen.add(key);
    if (kind !== "work") {
      items.push({ empId, date, kind });
      return;
    }
    const start = parseHm(get("開始"));
    const end = parseHm(get("終了"));
    if (start === undefined) return fail(`開始「${get("開始")}」は 9:00 の形式で入力してください`);
    if (end === undefined) return fail(`終了「${get("終了")}」は 18:00 の形式で入力してください（翌日の終了は 26:00 のように24時以降で指定できます）`);
    const brk = get("休憩（分）") || get("休憩") || "0";
    const breakMin = Number(brk);
    if (!Number.isInteger(breakMin) || breakMin < 0) return fail(`休憩「${brk}」は分の整数で入力してください`);
    const item: ScheduleItem = { empId, date, kind: "work", start, end, breakMin };
    const bad = checkWork(item);
    if (bad) return fail(bad);
    items.push(item);
  });
  return { items, errors };
}

/** 監査ログ用: 誰の・いつからいつまでのシフトを、何件変えたか（所定労働時間が変わるので、あとから追えるようにする） */
function auditDetail(items: ScheduleItem[]): { count: number; emps: string[]; empsTotal: number; from: string; to: string } {
  const emps = [...new Set(items.map((i) => i.empId))].sort();
  const dates = items.map((i) => i.date).sort();
  return { count: items.length, emps: emps.slice(0, 30), empsTotal: emps.length, from: dates[0]!, to: dates[dates.length - 1]! };
}

function apply(db: Db, items: ScheduleItem[]): void {
  const put = db.prepare("INSERT OR REPLACE INTO schedules (emp_id, date, kind, start, end, break_min) VALUES (?, ?, ?, ?, ?, ?)");
  const del = db.prepare("DELETE FROM schedules WHERE emp_id = ? AND date = ?");
  for (const i of items) {
    if (i.kind === "clear") del.run(i.empId, i.date);
    else if (i.kind === "work") put.run(i.empId, i.date, "work", i.start, i.end, i.breakMin);
    else put.run(i.empId, i.date, i.kind, null, null, 0);
  }
}

/** シフト（勤務予定）。変形労働時間制では、これが「あらかじめ定めた労働時間」になる */
export function scheduleRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/api/schedules", (c) => {
    const db = c.get("db");
    const me = c.get("me");
    const today = c.get("clock").now().date;
    const ym = c.req.query("ym") ?? today.slice(0, 7);
    if (!isYm(ym) || ym < addYm(today.slice(0, 7), -14) || ym > addYm(today.slice(0, 7), 14)) throw new ApiError(400, "対象月が正しくありません");
    const first = `${ym}-01`;
    const last = lastDateOfMonth(ym);
    const emps = loadEmployees(db).filter((e) => e.hired <= last && (me.role === "admin" || e.id === me.id));
    // 変形労働時間制・フレックスタイム制の社員（シフトが必要な社員）を先に並べる
    const order = (s: WorkStyle) => (s === "fixed" ? 1 : 0);
    emps.sort((a, b) => order(a.workStyle) - order(b.workStyle) || a.id.localeCompare(b.id));
    const ids = new Set(emps.map((e) => e.id));
    const rows = (
      db.prepare("SELECT emp_id AS empId, date, kind, start, end, break_min AS breakMin FROM schedules WHERE date >= ? AND date <= ? ORDER BY date, emp_id").all(first, last) as unknown as {
        empId: string;
        date: string;
        kind: "work" | "off" | "legal_off";
        start: number | null;
        end: number | null;
        breakMin: number;
      }[]
    )
      .filter((r) => ids.has(r.empId))
      .map((r) => ({ ...r, start: r.start ?? undefined, end: r.end ?? undefined }));
    const holidays = Object.fromEntries(
      (db.prepare("SELECT date, name FROM holidays WHERE date >= ? AND date <= ?").all(first, last) as unknown as { date: string; name: string }[]).map((h) => [h.date, h.name]),
    );
    const body: ScheduleResponse = {
      ym,
      today,
      holidays,
      employees: emps.map((e) => ({ ...brief(e), workStyle: e.workStyle, workDays: e.workDays, baseMin: e.baseMin, schedStart: e.schedStart })),
      rows,
    };
    return c.json(body);
  });

  const validate = (db: Db, today: string, items: ScheduleItem[]): ImportRowError[] => {
    const errors: ImportRowError[] = [];
    const known = new Set((db.prepare("SELECT id FROM employees WHERE active = 1").all() as { id: string }[]).map((r) => r.id));
    items.forEach((i, idx) => {
      const row = idx + 2;
      if (!known.has(i.empId)) errors.push({ row, message: `社員ID「${i.empId}」は在籍していません` });
      else if (i.date < addDays(today, -62) || i.date > addDays(today, 400)) errors.push({ row, message: `${i.date} は、過去2か月〜1年先の範囲を超えています` });
    });
    return errors;
  };

  app.post("/api/schedules", async (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const body = parse(z.object({ items: z.array(itemSchema).min(1, "変更がありません").max(MAX_ITEMS, `一度に変更できるのは${MAX_ITEMS}件までです`) }), await c.req.json().catch(() => null));
    const now = c.get("clock").now();
    for (const [idx, i] of body.items.entries()) {
      if (i.kind === "work") {
        const bad = checkWork(i);
        if (bad) throw new ApiError(400, `${idx + 1}件目: ${bad}`);
      }
    }
    const errors = validate(db, now.date, body.items);
    if (errors.length) throw new ApiError(400, `${errors[0]!.row - 1}件目: ${errors[0]!.message}`);
    tx(db, () => apply(db, body.items));
    audit(db, now.ts, admin.id, "schedule_update", auditDetail(body.items));
    return c.json({ ok: true, count: body.items.length });
  });

  app.post("/api/schedules/import", async (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const body = parse(z.object({ csv: z.string().max(2_000_000), dryRun: z.boolean().default(false) }), await c.req.json().catch(() => null));
    const now = c.get("clock").now();
    const { items, errors } = parseScheduleCsv(body.csv);
    if (!errors.length) errors.push(...validate(db, now.date, items));
    if (errors.length) return c.json({ ok: false, errors: errors.slice(0, 50) } satisfies ScheduleImportResponse);
    if (body.dryRun) return c.json({ ok: true, dryRun: true, count: items.length } satisfies ScheduleImportResponse);
    tx(db, () => apply(db, items));
    audit(db, now.ts, admin.id, "schedule_import", auditDetail(items));
    return c.json({ ok: true, dryRun: false, count: items.length } satisfies ScheduleImportResponse);
  });

  return app;
}
