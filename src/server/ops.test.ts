import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TenantManager } from "./control";
import { backupAll } from "./ops";
import { setup } from "./testkit";

const dir = () => mkdtempSync(join(tmpdir(), "ops-"));

function twoTenants(root: string) {
  const m = new TenantManager(join(root, "control.db"), join(root, "tenants"));
  const a = m.create({ code: "alpha", name: "A社", adminEmail: "a@example.com", nowMs: 1 });
  const b = m.create({ code: "bravo", name: "B社", adminEmail: "b@example.com", nowMs: 1 });
  for (const [t, n] of [[a, "山田"], [b, "鈴木"]] as const) {
    m.db(t.id).exec(
      `INSERT INTO employees (id, name, dept, kind, role, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, password_hash) VALUES ('x1', '${n}', '営業', '正社員', 'admin', '[1]', 1, 8, 480, 540, '2026-04-01', 'h')`,
    );
  }
  return { m, a, b };
}

describe("バックアップ", () => {
  it("全社のDBと管理用DBのスナップショットを作り、中身を読める", () => {
    const root = dir();
    const { m, a, b } = twoTenants(root);
    const r = backupAll(m, join(root, "backups"), new Date("2026-10-06T03:00:00Z"));
    expect(r.tenants).toBe(2);
    expect(readdirSync(r.dir).sort()).toEqual(["control.db", `${a.id}.db`, `${b.id}.db`].sort());
    const copy = new DatabaseSync(join(r.dir, `${a.id}.db`));
    expect(copy.prepare("SELECT name FROM employees").get()).toEqual({ name: "山田" });
    const ctl = new DatabaseSync(join(r.dir, "control.db"));
    expect(ctl.prepare("SELECT COUNT(*) AS n FROM tenants").get()).toEqual({ n: 2 });
    copy.close();
    ctl.close();
    m.close();
  });

  it("古い世代を削除して、指定した世代数だけ残す", () => {
    const root = dir();
    const { m } = twoTenants(root);
    for (let d = 1; d <= 4; d++) backupAll(m, join(root, "backups"), new Date(`2026-10-0${d}T03:00:00Z`), 2);
    expect(readdirSync(join(root, "backups")).sort()).toEqual(["20261003-030000", "20261004-030000"]);
    m.close();
  });
});

describe("会社データの削除", () => {
  it("指定した会社のファイルと登録だけが消え、他社には影響しない", () => {
    const root = dir();
    const { m, a, b } = twoTenants(root);
    m.purge(a.id);
    expect(existsSync(join(root, "tenants", `${a.id}.db`))).toBe(false);
    expect(m.findByCode("alpha")).toBeUndefined();
    expect(m.findByCode("bravo")).toBeDefined();
    expect(m.db(b.id).prepare("SELECT name FROM employees").get()).toEqual({ name: "鈴木" });
    m.close();
  });
});

describe("データの書き出し", () => {
  it("管理者は全データを書き出せる。パスワードのハッシュは含まれない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const r = await t.app.request("/api/export", { headers: { cookie: await t.login("e16") } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("export-demo-2026-10-06.json");
    const text = await r.text();
    expect(text).not.toContain("password");
    expect(text).not.toContain("scrypt$");
    const body = JSON.parse(text);
    expect(body.company).toEqual({ code: "demo", name: "デモ商事株式会社" });
    expect(body.employees).toHaveLength(18);
    expect(body.punchEvents.length).toBeGreaterThan(1000);
    expect(body.requests.length).toBeGreaterThan(0);
  });

  it("一般社員は書き出せない。解約後（閲覧のみ）でも管理者は書き出せる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect((await t.call("GET", "/api/export", { cookie: await t.login("e01") })).status).toBe(403);
    const admin = await t.login("e16");
    t.manager.update(t.tenant.id, { status: "canceled" });
    expect((await t.call("GET", "/api/export", { cookie: admin })).status).toBe(200);
  });
});

describe("運用コマンド", () => {
  it("list / backup / export / delete が動く", () => {
    const root = dir();
    const { m } = twoTenants(root);
    m.close();
    const run = (...args: string[]) => execFileSync("npx", ["tsx", "src/server/cli.ts", ...args], { env: { ...process.env, DATA_DIR: root }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(run("list")).toContain("alpha");
    expect(run("backup")).toContain("2社");
    expect(existsSync(join(root, "backups"))).toBe(true);
    const out = join(root, "alpha.json");
    run("export", "alpha", out);
    expect(JSON.parse(execFileSync("cat", [out], { encoding: "utf8" })).employees[0].name).toBe("山田");
    expect(() => run("delete", "alpha")).toThrow(); // --yes がないと削除しない
    run("delete", "alpha", "--yes");
    expect(run("list")).not.toContain("alpha");
    expect(run("list")).toContain("bravo");
  }, 60_000);
});

