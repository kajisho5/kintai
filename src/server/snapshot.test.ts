import { describe, expect, it } from "vitest";
import { tx } from "./db";
import { snapshot } from "./repo";
import { setup, TODAY } from "./testkit";

/** 集計（snapshot）の使い回し。古い集計を返さないことの確認 */
describe("snapshot の使い回し", () => {
  const prep = () => {
    const t = setup({ nowMin: -1, at: "10:00" });
    return { t, db: t.manager.db(t.tenant.id) };
  };
  const emp = (s: ReturnType<typeof snapshot>, id: string) => s.allEmployees.find((e) => e.id === id)!;
  const workMin = (s: ReturnType<typeof snapshot>, id: string) => s.ledger.todayResult(emp(s, id), s.nowMin).workMin;

  it("同じ状態では同じ集計を使い回す", () => {
    const { t, db } = prep();
    expect(snapshot(db, t.clock)).toBe(snapshot(db, t.clock));
    expect(snapshot(db, t.clock, { only: ["e01"] })).toBe(snapshot(db, t.clock, { only: ["e01"] }));
    expect(snapshot(db, t.clock, { only: ["e01"] })).not.toBe(snapshot(db, t.clock));
  });

  it("DBへの書き込み（打刻・設定・社員・シフト・有給）があれば、使い回さない", () => {
    const { t, db } = prep();
    const writes = [
      "INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES ('e02', '2026-10-06', 'in', 540, 1)",
      "UPDATE employees SET name = 'x' WHERE id = 'e03'",
      "INSERT OR REPLACE INTO schedules (emp_id, date, kind, start, end, break_min) VALUES ('e04', '2026-10-07', 'work', 540, 1080, 60)",
      "INSERT INTO paid_leave (emp_id, date, days) VALUES ('e05', '2026-10-05', 1)",
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('closing_day', '15')",
    ];
    for (const sql of writes) {
      const before = snapshot(db, t.clock);
      db.prepare(sql).run();
      expect(snapshot(db, t.clock), sql).not.toBe(before);
    }
  });

  it("書き込んだ打刻が、次の集計にすぐ反映される（古い集計を返さない）", () => {
    const { t, db } = prep();
    db.prepare("DELETE FROM punch_events WHERE emp_id = 'e07' AND date = ?").run(TODAY);
    expect(workMin(snapshot(db, t.clock, { only: ["e07"] }), "e07")).toBe(0);
    const ins = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES ('e07', ?, ?, ?, 1)");
    ins.run(TODAY, "in", 8 * 60);
    ins.run(TODAY, "out", 9 * 60);
    expect(workMin(snapshot(db, t.clock, { only: ["e07"] }), "e07")).toBe(60);
  });

  it("分が進めば、使い回さない（勤務中の時間が進む）", () => {
    const { t, db } = prep();
    const a = snapshot(db, t.clock);
    t.clock.set(TODAY, "10:01");
    expect(snapshot(db, t.clock)).not.toBe(a);
    t.clock.set(TODAY, "10:00");
  });

  it("日付が変われば使い回さない", () => {
    const { t, db } = prep();
    const a = snapshot(db, t.clock);
    t.clock.set("2026-10-07", "10:00");
    const b = snapshot(db, t.clock);
    expect(b).not.toBe(a);
    expect(b.today).toBe("2026-10-07");
  });

  it("別のDB（別の会社）の集計とは混ざらない", () => {
    const a = prep();
    const b = prep();
    const sa = snapshot(a.db, a.t.clock);
    const sb = snapshot(b.db, b.t.clock);
    expect(sa).not.toBe(sb);
    a.db.prepare("UPDATE employees SET name = 'AAA' WHERE id = 'e01'").run();
    expect(snapshot(b.db, b.t.clock)).toBe(sb);
  });

  it("1人分の集計は、全社員の集計と同じ結果になる", () => {
    const { t, db } = prep();
    const all = snapshot(db, t.clock);
    for (const id of ["e01", "e05", "e12", "e16"]) {
      const one = snapshot(db, t.clock, { only: [id] });
      expect(workMin(one, id), id).toBe(workMin(all, id));
      expect(one.ledger.monthOf(emp(one, id), "2026-10").result, id).toEqual(all.ledger.monthOf(emp(all, id), "2026-10").result);
      expect(one.ledger.leaveOf(emp(one, id)), id).toEqual(all.ledger.leaveOf(emp(all, id)));
    }
  });

  it("書き込みを取り消した（ロールバックした）あとは、取り消した打刻を含む集計を返さない", () => {
    const { t, db } = prep();
    db.prepare("DELETE FROM punch_events WHERE emp_id = 'e07' AND date = ?").run(TODAY);
    expect(() =>
      tx(db, () => {
        const ins = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES ('e07', ?, ?, ?, 1)");
        ins.run(TODAY, "in", 8 * 60);
        ins.run(TODAY, "out", 9 * 60);
        expect(workMin(snapshot(db, t.clock, { only: ["e07"] }), "e07")).toBe(60);
        throw new Error("取り消し");
      }),
    ).toThrow("取り消し");
    expect(workMin(snapshot(db, t.clock, { only: ["e07"] }), "e07")).toBe(0);
  });

  it("直前の月（前の協定期間の最終月）以外の backTo は、指定なしと同じ集計になる。直前の月なら、前の期間ぶんも読み込んだ別の集計", () => {
    const { t, db } = prep();
    const plain = snapshot(db, t.clock);
    expect(snapshot(db, t.clock, { backTo: "2026-10" })).toBe(plain);
    expect(snapshot(db, t.clock, { backTo: "2026-03" })).not.toBe(plain); // 4月始まりの年度の、直前の月
    expect(snapshot(db, t.clock)).toBe(plain);
  });
});
