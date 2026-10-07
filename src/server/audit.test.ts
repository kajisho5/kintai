import { beforeEach, describe, expect, it } from "vitest";
import type { AuditResponse } from "../domain";
import { setup } from "./testkit";

let t: ReturnType<typeof setup>;
let admin: string;
beforeEach(async () => {
  t = setup({ nowMin: 840, at: "14:00" });
  admin = await t.login("e16");
});
const get = (q = "") => t.call("GET", `/api/audit${q}`, { cookie: admin });
const csv = async (q = "", cookie = admin) => {
  const res = await t.app.request(`/api/audit/export${q}`, { headers: { cookie } });
  return { status: res.status, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(await res.arrayBuffer())), headers: res.headers };
};

describe("操作記録（監査ログ）", () => {
  it("管理者の操作が、新しい順に、日本語の操作名・操作者名つきで読める", async () => {
    await t.call("PATCH", "/api/employees/e01", { cookie: admin, body: { dept: "営業企画部" } });
    await t.call("PATCH", "/api/settings", { cookie: admin, body: { closingDay: 20 } });
    const r = (await get()).json as AuditResponse;
    expect(r.rows[0]).toMatchObject({ action: "settings_update", label: "会社設定の変更", actor: "e16", actorName: "山口 恵" });
    expect(r.rows[1]).toMatchObject({ action: "employee_update", label: "社員情報の変更" });
    expect((r.rows[1]!.detail as { id: string }).id).toBe("e01");
    expect(r.rows.map((x) => x.id)).toEqual([...r.rows.map((x) => x.id)].sort((a, b) => b - a));
    expect(r.actions.find((a) => a.action === "login")?.label).toBe("ログイン");
  });

  it("操作・操作者・期間で絞り込める。件数の上限と、続きの取得（before）がある", async () => {
    const e01 = await t.login("e01");
    await t.call("POST", "/api/punch", { cookie: e01, body: { action: "in" } });
    await t.call("PATCH", "/api/settings", { cookie: admin, body: { closingDay: 20 } });
    expect(((await get("?action=punch")).json as AuditResponse).rows.every((x) => x.action === "punch")).toBe(true);
    expect(((await get("?actor=e01")).json as AuditResponse).rows.every((x) => x.actor === "e01")).toBe(true);
    expect(((await get("?actor=e01&action=settings_update")).json as AuditResponse).rows).toEqual([]);
    expect(((await get("?from=2100-01-01")).json as AuditResponse).rows).toEqual([]); // 未来の日付から
    expect(((await get("?from=2026-10-06&to=2026-10-06")).json as AuditResponse).rows.length).toBeGreaterThan(0);

    const page1 = (await get("?limit=2")).json as AuditResponse;
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextBefore).toBe(page1.rows[1]!.id);
    const page2 = (await get(`?limit=2&before=${page1.nextBefore}`)).json as AuditResponse;
    expect(page2.rows[0]!.id).toBeLessThan(page1.rows[1]!.id);
    const all = (await get("?limit=200")).json as AuditResponse;
    expect(all.nextBefore).toBeUndefined();
  });

  it("不正な指定は拒否される。一般の社員は閲覧できない", async () => {
    expect((await get("?limit=1000")).status).toBe(400);
    expect((await get("?from=2026-13-01")).status).toBe(400);
    expect((await get("?before=abc")).status).toBe(400);
    const emp = await t.login("e02");
    expect((await t.call("GET", "/api/audit", { cookie: emp })).status).toBe(403);
    expect((await csv("", emp)).status).toBe(403);
    expect((await t.call("GET", "/api/audit")).status).toBe(401);
  });

  it("CSVで書き出せる（日本時間・BOMつき・数式の無害化）。書き出したこと自体も記録に残る", async () => {
    t.db.prepare("UPDATE employees SET name = '=cmd|calc' WHERE id = 'e16'").run();
    await t.call("PATCH", "/api/settings", { cookie: admin, body: { closingDay: 20 } });
    const r = await csv("?action=settings_update");
    expect(r.status).toBe(200);
    expect(r.text.startsWith("﻿日時（日本時間）,操作者ID,操作者,操作,内容")).toBe(true);
    const line = r.text.split("\r\n")[1]!;
    expect(line).toMatch(/^2026-10-06 14:00:\d\d,e16,'=cmd\|calc,会社設定の変更,/);
    expect(r.headers.get("content-disposition")).toContain(encodeURIComponent("操作記録_2026-10-06.csv"));
    const log = ((await get("?action=export")).json as AuditResponse).rows[0]!;
    expect(log.detail).toMatchObject({ kind: "audit" });
  });

  it("共用端末の操作者は「kiosk:端末名」で残り、暗証番号の誤りには、存在する社員IDだけが残る", async () => {
    const token = (await t.call("POST", "/api/kiosk/terminals", { cookie: admin, body: { name: "玄関" } })).json.token;
    const pin = (await t.call("POST", "/api/employees/e01/pin", { cookie: admin })).json.pin;
    t.clock.set("2026-10-07", "09:00");
    const id = (await t.call("POST", "/api/kiosk/identify", { body: { token, empId: "e01", pin } })).json;
    await t.call("POST", "/api/kiosk/punch", { body: { token, ticket: id.ticket, action: "in" } });
    await t.call("POST", "/api/kiosk/identify", { body: { token, empId: "e01", pin: "000000" } });
    await t.call("POST", "/api/kiosk/identify", { body: { token, empId: "123456", pin: "000000" } });
    admin = await t.login("e16"); // セッションは12時間で切れる
    const bad = ((await get("?action=kiosk_pin_failed")).json as AuditResponse).rows;
    expect(bad.map((x) => x.actor)).toEqual(["e01"]); // 存在しない社員ID（入力欄に入れた文字列）は残らない
    const r = (await get("?action=punch_kiosk")).json as AuditResponse;
    expect(r.rows[0]).toMatchObject({ actor: "kiosk:玄関", label: "打刻（共用端末）" });
    expect((r.rows[0]!.detail as { emp: string }).emp).toBe("e01");
  });
});
