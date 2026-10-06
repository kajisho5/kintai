import { describe, expect, it } from "vitest";
import { addDays } from "../domain";
import { tx } from "./db";
import { snapshot, snapshotFresh, snapshotStats, type Snapshot } from "./repo";
import { setup, TODAY } from "./testkit";

/** 全社員の主な集計結果。差分で更新した集計と、ゼロから作った集計を比べるために使う */
function digest(snap: Snapshot) {
  const out: Record<string, unknown> = { today: snap.today, nowMin: snap.nowMin, months: snap.pickerMonths, geo: snap.geoSiteCount };
  const l = snap.ledger;
  for (const e of snap.employees) {
    const yms = [snap.currentYm, snap.pickerMonths[0]!];
    out[e.id] = {
      today: l.todayRow(e, snap.nowMin),
      todayResult: l.todayResult(e, snap.nowMin),
      risk: l.riskOf(e),
      leave: l.leaveOf(e),
      series: l.overtimeSeries(e, snap.currentYm),
      months: yms.map((ym) => ({ ym, m: l.monthOf(e, ym), rows: l.dayRows(e, ym), o: l.outlookOf(e, ym, snap.fyMonths) })),
      today7: Array.from({ length: 9 }, (_, i) => l.planOf(e, addDays(snap.today, i - 7))),
    };
  }
  return out;
}

/** 決定論的な擬似乱数 */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

describe("集計の差分更新（ゼロから作った集計と一致する）", () => {
  const prep = () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const db = t.manager.db(t.tenant.id);
    // 勤務区分を散らす。変形・フレックスの社員にはシフトを入れる
    const styles: [string, string][] = [["e02", "flex"], ["e03", "yearly"], ["e04", "monthly"], ["e05", "weekly"]];
    for (const [id, st] of styles) {
      db.prepare("UPDATE employees SET work_style = ? WHERE id = ?").run(st, id);
      for (let i = -40; i <= 40; i++) {
        const d = addDays(TODAY, i);
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        db.prepare("INSERT OR REPLACE INTO schedules (emp_id, date, kind, start, end, break_min) VALUES (?, ?, 'work', 540, 1080, 60)").run(id, d);
      }
    }
    return { t, db };
  };

  it("打刻の追加（本日・前日・過去・日またぎ）と時刻の経過を繰り返しても、毎回ゼロから作った結果と一致する", () => {
    const { t, db } = prep();
    const rand = rng(12345);
    const ids = ["e01", "e02", "e03", "e04", "e05", "e06", "e07", "e08", "e09", "e10", "e11", "e12"];
    const ins = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES (?, ?, ?, ?, 1)");
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    let minute = 600;
    snapshot(db, t.clock);
    expect(digest(snapshot(db, t.clock))).toEqual(digest(snapshotFresh(db, t.clock)));
    const before = { ...snapshotStats };

    for (let step = 0; step < 80; step++) {
      const op = rand();
      const id = pick(ids);
      if (op < 0.3) {
        // 本日の打刻
        const day = TODAY;
        const kind = pick(["in", "break_start", "break_end", "out"]);
        ins.run(id, day, kind, Math.min(1439, 480 + Math.floor(rand() * 600)));
      } else if (op < 0.5) {
        // 前日の打刻（日またぎで続く勤務・退勤）
        const y = addDays(TODAY, -1);
        if (rand() < 0.5) ins.run(id, y, "in", 1320);
        else ins.run(id, y, "out", 1440 + Math.floor(rand() * 400));
      } else if (op < 0.75) {
        // 過去数日の打刻（修正申請の承認に相当）
        const d = addDays(TODAY, -2 - Math.floor(rand() * 20));
        for (const [k, m] of [["in", 540], ["out", 1080 + Math.floor(rand() * 200)]] as const) ins.run(id, d, k, m);
      } else {
        minute += 1 + Math.floor(rand() * 5);
        t.clock.set(TODAY, `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);
      }
      expect(digest(snapshot(db, t.clock)), `step ${step}`).toEqual(digest(snapshotFresh(db, t.clock)));
    }
    // 差分で更新した回数が、作り直した回数より多い（毎回作り直していない）
    expect(snapshotStats.incremental - before.incremental).toBeGreaterThan(40);
    expect(snapshotStats.built - before.built).toBe(0);
  }, 120_000);

  it("社員・設定・シフト・有給・祝日が変わったときは作り直し、結果は一致する", () => {
    const { t, db } = prep();
    snapshot(db, t.clock);
    const writes: [string, unknown[]][] = [
      ["UPDATE employees SET work_style = 'fixed' WHERE id = 'e02'", []],
      ["INSERT OR REPLACE INTO settings (key, value) VALUES ('closing_day', '15')", []],
      ["INSERT OR REPLACE INTO schedules (emp_id, date, kind, start, end, break_min) VALUES ('e03', ?, 'legal_off', NULL, NULL, 0)", [addDays(TODAY, 2)]],
      ["INSERT INTO paid_leave (emp_id, date, days) VALUES ('e06', ?, 1)", [addDays(TODAY, -3)]],
      ["INSERT OR REPLACE INTO holidays (date, name) VALUES (?, '臨時休日')", [addDays(TODAY, -4)]],
      ["DELETE FROM schedules WHERE emp_id = 'e04'", []],
      ["INSERT OR REPLACE INTO settings (key, value) VALUES ('closing_day', '0')", []],
    ];
    for (const [sql, args] of writes) {
      const built = snapshotStats.built;
      db.prepare(sql).run(...(args as never[]));
      expect(digest(snapshot(db, t.clock)), sql).toEqual(digest(snapshotFresh(db, t.clock)));
      expect(snapshotStats.built, sql).toBe(built + 1);
    }
  });

  it("日付が変わったとき、過去より前の打刻が増えたとき、ロールバックのあとは、作り直して結果が一致する", () => {
    const { t, db } = prep();
    snapshot(db, t.clock);
    const ins = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES (?, ?, ?, ?, 1)");

    // 読み込み範囲より前の日付（昔の記録の追加）
    let built = snapshotStats.built;
    ins.run("e07", "2020-01-06", "in", 540);
    ins.run("e07", "2020-01-06", "out", 1080);
    expect(digest(snapshot(db, t.clock))).toEqual(digest(snapshotFresh(db, t.clock)));
    expect(snapshotStats.built).toBe(built + 1);

    // 日付が変わる
    built = snapshotStats.built;
    t.clock.set("2026-10-07", "00:05");
    expect(digest(snapshot(db, t.clock))).toEqual(digest(snapshotFresh(db, t.clock)));
    expect(snapshotStats.built).toBe(built + 1);
  });

  it("前日から続く勤務（退勤なし）は、時刻が進んで20時間を超えると、「勤務中」の注記が「退勤打刻なし」に変わる", () => {
    const { t, db } = prep();
    db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES ('e08', ?, 'in', 1320, 1)").run(addDays(TODAY, -1));
    t.clock.set(TODAY, "17:58");
    const note = (s: Snapshot) => s.ledger.planOf(s.employees.find((e) => e.id === "e08")!, addDays(TODAY, -1)).note;
    expect(note(snapshot(db, t.clock))).toBe("勤務中（日またぎ）");
    expect(digest(snapshot(db, t.clock))).toEqual(digest(snapshotFresh(db, t.clock)));
    t.clock.set(TODAY, "18:02");
    const built = snapshotStats.built;
    expect(note(snapshot(db, t.clock))).toBe("退勤打刻なし");
    expect(snapshotStats.built).toBe(built); // 作り直さず、差分で反映している
    expect(digest(snapshot(db, t.clock))).toEqual(digest(snapshotFresh(db, t.clock)));
  });

  it("打刻場所（位置情報）の登録数の変更は、時刻が同じでも、すぐに反映される", () => {
    const { t, db } = prep();
    expect(snapshot(db, t.clock).geoSiteCount).toBe(0);
    db.prepare("INSERT INTO geo_sites (name, lat, lng, radius_m) VALUES ('本社', 35.0, 139.0, 100)").run();
    expect(snapshot(db, t.clock).geoSiteCount).toBe(1);
    db.prepare("DELETE FROM geo_sites").run();
    expect(snapshot(db, t.clock).geoSiteCount).toBe(0);
  });

  it("何も書かずに失敗した処理（入力の誤りなど）では、集計を作り直さない。書き込んだあとに失敗（ロールバック）したときは作り直す", () => {
    const { t, db } = prep();
    snapshot(db, t.clock);
    const built = snapshotStats.built;
    expect(() => tx(db, () => { throw new Error("入力の誤り"); })).toThrow();
    snapshot(db, t.clock);
    expect(snapshotStats.built).toBe(built);
    expect(() => tx(db, () => { db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES ('e07', ?, 'in', 540, 1)").run(TODAY); throw new Error("途中で失敗"); })).toThrow();
    expect(digest(snapshot(db, t.clock))).toEqual(digest(snapshotFresh(db, t.clock)));
    expect(snapshotStats.built).toBe(built + 1);
  });
});
