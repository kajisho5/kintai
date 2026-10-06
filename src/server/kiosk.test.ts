import { beforeEach, describe, expect, it } from "vitest";
import type { KioskHello, KioskIdentified, KioskPunched, KioskTerminal } from "../domain";
import { PASSWORD, setup, TODAY } from "./testkit";

const NEXT = "2026-10-07";
let t: ReturnType<typeof setup>;
let admin: string;
let token: string;

beforeEach(async () => {
  t = setup({ nowMin: -1, at: "09:00" }); // 本日の打刻なし
  admin = await t.login("e16");
  token = (await t.call("POST", "/api/kiosk/terminals", { cookie: admin, body: { name: "正面玄関" } })).json.token;
});
const issuePin = async (id = "e01") => (await t.call("POST", `/api/employees/${id}/pin`, { cookie: admin })).json.pin as string;
const identify = (body: Record<string, unknown>, tok = token) => t.call("POST", "/api/kiosk/identify", { body: { token: tok, ...body } });
const punch = (ticket: string, action: string, tok = token) => t.call("POST", "/api/kiosk/punch", { body: { token: tok, ticket, action } });
const events = (id: string, date = TODAY) => t.db.prepare("SELECT kind, min, source FROM punch_events WHERE emp_id = ? AND date = ? ORDER BY seq").all(id, date) as { kind: string; min: number; source: string }[];

describe("共用の打刻端末: 登録と確認", () => {
  it("管理者が端末を登録すると、トークンつきのURLが一度だけ表示され、一覧にはトークンが出ない", async () => {
    const r = (await t.call("POST", "/api/kiosk/terminals", { cookie: admin, body: { name: "事務所" } })).json;
    expect(r.token).toMatch(/^[0-9a-f]{16}\.[A-Za-z0-9_-]{20,}$/);
    expect(r.url).toBe(`https://app.example.com/app/#/kiosk?t=${r.token}`);
    const list = (await t.call("GET", "/api/kiosk/terminals", { cookie: admin })).json as KioskTerminal[];
    expect(list.map((x) => x.name)).toEqual(["事務所", "正面玄関"]);
    expect(JSON.stringify(list)).not.toContain(r.token.split(".")[1]);
    expect(t.db.prepare("SELECT token_hash AS h FROM kiosk_terminals WHERE id = ?").get(r.id)).not.toEqual({ h: r.token }); // 保存はハッシュ
  });

  it("端末の画面は、会社名・端末名・サーバーの時刻を取得できる。無効なトークンは拒否される", async () => {
    const r = (await t.call("POST", "/api/kiosk/hello", { body: { token } })).json as KioskHello;
    expect(r).toMatchObject({ company: "デモ商事株式会社", terminal: "正面玄関", today: TODAY, nowMin: 540, writable: true });
    expect((await t.call("POST", "/api/kiosk/hello", { body: { token: "abc.defghijklmnop" } })).status).toBe(401);
    expect((await t.call("POST", "/api/kiosk/hello", { body: { token: `${t.tenant.id}.wrongsecretwrongsecret` } })).status).toBe(401);
    expect((await t.call("POST", "/api/kiosk/hello", { body: { token: "x" } })).status).toBe(400);
  });

  it("一般の社員は、端末・暗証番号・カードを管理できない", async () => {
    const emp = await t.login("e02");
    expect((await t.call("POST", "/api/kiosk/terminals", { cookie: emp, body: { name: "x" } })).status).toBe(403);
    expect((await t.call("GET", "/api/kiosk/terminals", { cookie: emp })).status).toBe(403);
    expect((await t.call("POST", "/api/employees/e01/pin", { cookie: emp })).status).toBe(403);
    expect((await t.call("PUT", "/api/employees/e01/card", { cookie: emp, body: { card: "ABCD1234" } })).status).toBe(403);
  });

  it("無効にした端末は、そのトークンでは何もできない", async () => {
    const id = (await t.call("GET", "/api/kiosk/terminals", { cookie: admin })).json[0].id;
    expect((await t.call("DELETE", `/api/kiosk/terminals/${id}`, { cookie: admin })).status).toBe(200);
    expect((await t.call("POST", "/api/kiosk/hello", { body: { token } })).status).toBe(401);
    expect((await t.call("DELETE", `/api/kiosk/terminals/${id}`, { cookie: admin })).status).toBe(404);
  });
});

describe("共用の打刻端末: 暗証番号で打刻", () => {
  it("社員ID＋暗証番号で確認し、出勤→休憩→退勤を打刻できる。記録はサーバー時刻・共用端末として残る", async () => {
    const pin = await issuePin();
    expect(pin).toMatch(/^\d{6}$/);
    let id = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    expect(id).toMatchObject({ emp: { id: "e01", name: "佐藤 健太" }, phase: "before", allowed: ["in"] });
    const r = (await punch(id.ticket, "in")).json as KioskPunched;
    expect(r).toMatchObject({ action: "in", at: 540, emp: { id: "e01" } });
    expect(events("e01")).toEqual([{ kind: "in", min: 540, source: "kiosk" }]);

    t.clock.set(TODAY, "12:00");
    id = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    expect(id).toMatchObject({ phase: "working", allowed: ["break_start", "out"] });
    await punch(id.ticket, "break_start");
    t.clock.set(TODAY, "13:00");
    id = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    expect(id).toMatchObject({ phase: "break", allowed: ["break_end", "out"] });
    await punch(id.ticket, "break_end");
    t.clock.set(TODAY, "18:00");
    id = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    await punch(id.ticket, "out");
    id = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    expect(id).toMatchObject({ phase: "done", allowed: [] });
    expect(events("e01").map((e) => e.kind)).toEqual(["in", "break_start", "break_end", "out"]);
    const log = t.db.prepare("SELECT actor, action FROM audit_log WHERE action = 'punch_kiosk' ORDER BY id").all() as { actor: string; action: string }[];
    expect(log).toHaveLength(4);
    expect(log[0]!.actor).toBe("kiosk:正面玄関");
  });

  it("確認の有効時間（90秒）を過ぎたり、使用済みのチケットでは打刻できない。別の端末のチケットも使えない", async () => {
    const pin = await issuePin();
    const id = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    expect((await punch(id.ticket, "in")).status).toBe(200);
    expect((await punch(id.ticket, "out")).status).toBe(401); // 1回限り

    t.clock.set(TODAY, "12:00");
    const id2 = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    const other = (await t.call("POST", "/api/kiosk/terminals", { cookie: admin, body: { name: "別の端末" } })).json.token;
    expect((await punch(id2.ticket, "break_start", other)).status).toBe(401);
    t.clock.set(TODAY, "12:02"); // 120秒後
    expect((await punch(id2.ticket, "break_start")).status).toBe(401);
  });

  it("暗証番号を間違えると拒否され、5回続くとロックされる（正しい番号でも入れない）。暗証番号が無い社員・存在しない社員も同じ応答", async () => {
    const pin = await issuePin();
    const wrong = await identify({ empId: "e01", pin: pin === "123456" ? "654321" : "123456" });
    expect(wrong.status).toBe(401);
    expect((await identify({ empId: "e02", pin: "123456" })).json.error).toBe(wrong.json.error); // 暗証番号が未発行
    expect((await identify({ empId: "nobody", pin: "123456" })).json.error).toBe(wrong.json.error);
    for (let i = 0; i < 4; i++) await identify({ empId: "e01", pin: "000001" }); // 最初の1回と合わせて5回目の失敗でロック
    const locked = await identify({ empId: "e01", pin });
    expect(locked.status).toBe(423);
    t.clock.set(TODAY, "09:06"); // 5分後に解除
    expect((await identify({ empId: "e01", pin })).status).toBe(200);
  });

  it("退職した社員・暗証番号を削除した社員は確認できない", async () => {
    const pin = await issuePin("e02");
    expect((await identify({ empId: "e02", pin })).status).toBe(200);
    expect((await t.call("DELETE", "/api/employees/e02/pin", { cookie: admin })).status).toBe(200);
    expect((await identify({ empId: "e02", pin })).status).toBe(401);
    const pin3 = await issuePin("e03");
    await t.call("POST", "/api/employees/e03/deactivate", { cookie: admin });
    expect((await identify({ empId: "e03", pin: pin3 })).status).toBe(401);
    expect((await t.call("POST", "/api/employees/e03/pin", { cookie: admin })).status).toBe(409);
  });

  it("出勤の二重打刻は拒否される（確認は通るが、打刻は 409）", async () => {
    const pin = await issuePin();
    const a = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    await punch(a.ticket, "in");
    const b = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    expect((await punch(b.ticket, "in")).status).toBe(409);
    expect(events("e01")).toHaveLength(1);
  });

  it("夜勤: 夜に出勤し、翌朝に端末で退勤すると、始業日の勤務として記録される", async () => {
    const pin = await issuePin();
    t.clock.set(TODAY, "22:00");
    await punch(((await identify({ empId: "e01", pin })).json as KioskIdentified).ticket, "in");
    t.clock.set(NEXT, "07:00");
    const id = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    expect(id).toMatchObject({ phase: "working", allowed: ["break_start", "out"] });
    const r = (await punch(id.ticket, "out")).json as KioskPunched;
    expect(r.at).toBe(1860);
    expect(events("e01", TODAY).map((e) => [e.kind, e.min])).toEqual([["in", 1320], ["out", 1860]]);
    // 退勤後は、次の勤務の出勤ができる
    t.clock.set(NEXT, "08:00");
    expect(((await identify({ empId: "e01", pin })).json as KioskIdentified).allowed).toEqual(["in"]);
  });

  it("トライアル終了後など、契約が有効でないときは、確認はできても打刻は 402", async () => {
    const pin = await issuePin();
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: t.clock.now().ts - 1000 });
    expect((await t.call("POST", "/api/kiosk/hello", { body: { token } })).json.writable).toBe(false);
    const id = (await identify({ empId: "e01", pin })).json as KioskIdentified;
    expect((await punch(id.ticket, "in")).status).toBe(402);
    expect(events("e01")).toEqual([]);
  });

  it("停止された会社の端末は使えない", async () => {
    t.manager.update(t.tenant.id, { status: "suspended" });
    expect((await t.call("POST", "/api/kiosk/hello", { body: { token } })).status).toBe(403);
  });
});

describe("共用の打刻端末: ICカード", () => {
  const card = async (id: string, value: string) => t.call("PUT", `/api/employees/${id}/card`, { cookie: admin, body: { card: value } });

  it("カードを登録した社員は、カードだけで確認できる。区切りや大文字小文字の違いは同じカードとして扱う", async () => {
    expect((await card("e01", "04:A3:1b:2C")).status).toBe(200);
    for (const v of ["04A31B2C", "04-a3-1b-2c", " 04 A3 1B 2C "]) {
      expect(((await identify({ card: v })).json as KioskIdentified).emp.id).toBe("e01");
    }
    expect((await identify({ card: "04A31B2D" })).status).toBe(401);
    const row = t.db.prepare("SELECT card_hash AS h FROM employees WHERE id = 'e01'").get() as { h: string };
    expect(row.h).not.toContain("04A31B2C"); // カード番号そのものは保存しない
  });

  it("同じカードを複数の社員に登録できない。差し替え・削除ができる。形式が不正なカードは拒否される", async () => {
    await card("e01", "04A31B2C");
    expect((await card("e02", "04a31b2c")).status).toBe(409);
    expect((await card("e01", "99999999")).status).toBe(200); // 差し替え
    expect((await identify({ card: "04A31B2C" })).status).toBe(401);
    expect((await card("e02", "04A31B2C")).status).toBe(200); // 空いたカードは別の社員に登録できる
    expect((await card("e01", "ab")).status).toBe(400);
    expect((await card("e01", "!!!!!!")).status).toBe(400);
    await t.call("DELETE", "/api/employees/e01/card", { cookie: admin });
    expect((await identify({ card: "99999999" })).status).toBe(401);
  });

  it("カードの読み取りに続けて失敗すると、端末が一時的に止まる", async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await identify({ card: `ZZZZ${i}0000` })).status;
    expect(last).toBe(429);
  });

  it("暗証番号もカードも無い要求は 400。社員一覧には暗証番号・カードの登録状況だけが出る", async () => {
    expect((await identify({})).status).toBe(400);
    await issuePin("e01");
    await card("e01", "AAAA1111");
    const e01 = (await t.call("GET", "/api/employees", { cookie: admin })).json.rows.find((r: { id: string }) => r.id === "e01");
    expect(e01).toMatchObject({ hasPin: true, hasCard: true });
    expect(JSON.stringify(e01)).not.toContain("AAAA1111");
    expect(PASSWORD).toBeTruthy();
  });
});
