import { beforeEach, describe, expect, it } from "vitest";
import type { AttendanceDetailResponse, PunchStateResponse, SettingsResponse } from "../domain";
import { distanceM, evaluateGeo } from "./punch";
import { setup, TODAY } from "./testkit";

// 東京駅（丸の内口）付近
const OFFICE = { lat: 35.681236, lng: 139.767125 };
/** 北へ約 m メートル */
const north = (m: number) => ({ lat: OFFICE.lat + m / 111_195, lng: OFFICE.lng });

describe("距離と範囲の判定", () => {
  it("2点間の距離（球面）。緯度1度は約111km", () => {
    expect(distanceM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeGreaterThan(111_000);
    expect(distanceM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeLessThan(111_400);
    expect(distanceM(OFFICE, OFFICE)).toBe(0);
    expect(distanceM(OFFICE, north(500))).toBeGreaterThan(495);
    expect(distanceM(OFFICE, north(500))).toBeLessThan(505);
  });

  it("半径＋位置の誤差（上限100m）の範囲に入っていれば範囲内。場所が未登録なら判定できない", () => {
    const sites = [{ ...OFFICE, radius_m: 100 }];
    expect(evaluateGeo(sites, north(90))).toBe("in");
    expect(evaluateGeo(sites, north(150))).toBe("out");
    expect(evaluateGeo(sites, { ...north(150), accuracy: 80 })).toBe("in"); // 誤差の分を許容
    expect(evaluateGeo(sites, { ...north(250), accuracy: 5000 })).toBe("out"); // 誤差の許容は100mまで
    expect(evaluateGeo([], north(0))).toBe("unknown");
    expect(evaluateGeo([...sites, { ...north(1000), radius_m: 200 }], north(1050))).toBe("in"); // どれか1つに入っていればよい
  });
});

describe("位置情報つきの打刻", () => {
  let t: ReturnType<typeof setup>;
  let admin: string;
  const patch = (body: unknown) => t.call("PATCH", "/api/settings", { cookie: admin, body });
  const addSite = (over: Record<string, unknown> = {}) => t.call("POST", "/api/settings/geo-sites", { cookie: admin, body: { name: "本社", ...OFFICE, radiusM: 100, ...over } });
  const geoOf = (id: string) => t.db.prepare("SELECT geo, lat, lng FROM punch_events WHERE emp_id = ? AND date = ? ORDER BY seq").all(id, TODAY) as { geo: string | null; lat: number | null; lng: number | null }[];

  beforeEach(async () => {
    t = setup({ nowMin: -1, at: "09:00" });
    admin = await t.login("e16");
  });

  it("設定が無効（既定）なら、位置情報は記録されず、判定もされない", async () => {
    const c = await t.login("e01");
    const r = await t.call("POST", "/api/punch", { cookie: c, body: { action: "in", geo: { ...north(5000) } } });
    expect(r.status).toBe(200);
    expect(r.json.geo).toEqual({ mode: "off", required: false });
    expect(geoOf("e01")).toEqual([{ geo: null, lat: null, lng: null }]); // 無効なら、送られてきた位置情報は保存しない
  });

  it("記録モード: 範囲内・範囲外・位置情報なしを記録し、打刻自体は止めない。勤怠の詳細に、範囲外・不明の日が出る", async () => {
    await addSite();
    await patch({ geoMode: "record" });
    const c = await t.login("e01");
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "in", geo: { ...north(50), accuracy: 10 } } })).status).toBe(200);
    t.clock.set(TODAY, "12:00");
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "break_start", geo: north(3000) } })).status).toBe(200);
    t.clock.set(TODAY, "13:00");
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "break_end" } })).status).toBe(200); // 位置情報なし
    expect(geoOf("e01").map((e) => e.geo)).toEqual(["in", "out", "unknown"]);
    t.clock.set(TODAY, "18:00");
    await t.call("POST", "/api/punch", { cookie: c, body: { action: "out", geo: OFFICE } });
    t.clock.set("2026-10-07", "09:00");
    const c2 = await t.login("e01");
    const d = (await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: c2 })).json as AttendanceDetailResponse;
    expect(d.geoFlags[TODAY]).toBe("out"); // 範囲外が優先
  });

  it("制限モード: 範囲外や位置情報なしでは出勤できない。範囲内なら出勤できる。制限の対象外の社員は出勤できる。退勤・休憩は止めず、範囲外として記録する", async () => {
    await addSite();
    await patch({ geoMode: "enforce" });
    const c = await t.login("e01");
    const state = (await t.call("GET", "/api/punch/today", { cookie: c })).json as PunchStateResponse;
    expect(state.geo).toEqual({ mode: "enforce", required: true });
    const far = await t.call("POST", "/api/punch", { cookie: c, body: { action: "in", geo: north(2000) } });
    expect(far.status).toBe(403);
    expect(far.json.code).toBe("GEO_OUTSIDE");
    const none = await t.call("POST", "/api/punch", { cookie: c, body: { action: "in" } });
    expect(none.status).toBe(403);
    expect(none.json.code).toBe("GEO_REQUIRED");
    expect(geoOf("e01")).toEqual([]); // 拒否された打刻は記録されない
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "in", geo: north(30) } })).status).toBe(200);
    t.clock.set(TODAY, "18:00");
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "out", geo: north(3000) } })).status).toBe(200); // 退勤は範囲外でも打刻できる
    expect(geoOf("e01").map((e) => e.geo)).toEqual(["in", "out"]);
    t.clock.set(TODAY, "09:00");

    await t.call("PATCH", "/api/employees/e02", { cookie: admin, body: { geoExempt: true } });
    const e02 = await t.login("e02");
    expect(((await t.call("GET", "/api/punch/today", { cookie: e02 })).json as PunchStateResponse).geo.required).toBe(false);
    expect((await t.call("POST", "/api/punch", { cookie: e02, body: { action: "in" } })).status).toBe(200);
    expect(geoOf("e02")[0]!.geo).toBe("unknown");
  });

  it("記録モードでも、打刻場所が1件も登録されていなければ、判定に使わない座標は保存しない", async () => {
    await patch({ geoMode: "record" });
    const c = await t.login("e01");
    await t.call("POST", "/api/punch", { cookie: c, body: { action: "in", geo: north(10) } });
    expect(geoOf("e01")).toEqual([{ geo: "unknown", lat: null, lng: null }]);
  });

  it("打刻場所が1件も無ければ、制限モードでも打刻は止まらない（設定ミスで全員が打刻できなくなるのを防ぐ）", async () => {
    await patch({ geoMode: "enforce" });
    const c = await t.login("e01");
    expect(((await t.call("GET", "/api/punch/today", { cookie: c })).json as PunchStateResponse).geo.required).toBe(false);
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "in" } })).status).toBe(200);
  });

  it("共用端末の打刻は、制限モードでも位置情報を求めない", async () => {
    await addSite();
    await patch({ geoMode: "enforce" });
    const token = (await t.call("POST", "/api/kiosk/terminals", { cookie: admin, body: { name: "玄関" } })).json.token;
    const pin = (await t.call("POST", "/api/employees/e01/pin", { cookie: admin })).json.pin;
    const id = (await t.call("POST", "/api/kiosk/identify", { body: { token, empId: "e01", pin } })).json;
    expect((await t.call("POST", "/api/kiosk/punch", { body: { token, ticket: id.ticket, action: "in" } })).status).toBe(200);
    expect(geoOf("e01")[0]!.geo).toBeNull();
  });

  it("打刻場所の登録・削除と、設定の検証（緯度・経度・半径・件数・権限）", async () => {
    expect((await addSite()).status).toBe(201);
    expect((await addSite({ lat: 95 })).status).toBe(400);
    expect((await addSite({ lng: -200 })).status).toBe(400);
    expect((await addSite({ radiusM: 5 })).status).toBe(400);
    expect((await addSite({ radiusM: 9000 })).status).toBe(400);
    expect((await addSite({ name: "" })).status).toBe(400);
    expect((await patch({ geoMode: "maybe" })).status).toBe(400);
    const s = (await t.call("GET", "/api/settings", { cookie: admin })).json as SettingsResponse;
    expect(s.geoSites).toHaveLength(1);
    expect(s.geoSites[0]).toMatchObject({ name: "本社", radiusM: 100 });
    const emp = await t.login("e01");
    expect((await t.call("POST", "/api/settings/geo-sites", { cookie: emp, body: { name: "x", ...OFFICE, radiusM: 100 } })).status).toBe(403);
    expect((await t.call("DELETE", `/api/settings/geo-sites/${s.geoSites[0]!.id}`, { cookie: admin })).status).toBe(200);
    expect((await t.call("DELETE", `/api/settings/geo-sites/${s.geoSites[0]!.id}`, { cookie: admin })).status).toBe(404);
  });

  it("不正な位置情報の値は拒否される", async () => {
    const c = await t.login("e01");
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "in", geo: { lat: 100, lng: 0 } } })).status).toBe(400);
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "in", geo: { lat: "x", lng: 0 } } })).status).toBe(400);
  });
});
