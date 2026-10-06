import type { AccessState } from "../domain/api";
import type { Tenant } from "./control";

export type { AccessState };

import { PLAN } from "../pricing";

export { PLAN };

export interface Access {
  state: AccessState;
  /** データの追加・変更ができるか（false の間は閲覧のみ） */
  writable: boolean;
  seatLimit: number;
  trialDaysLeft?: number;
}

const DAY = 86400_000;

export function accessOf(t: Pick<Tenant, "status" | "trialEndsAt" | "pastDueSince">, nowMs: number): Access {
  switch (t.status) {
    case "trialing": {
      if (nowMs > t.trialEndsAt) return { state: "trial_expired", writable: false, seatLimit: PLAN.trialSeatLimit };
      return { state: "trialing", writable: true, seatLimit: PLAN.trialSeatLimit, trialDaysLeft: Math.max(0, Math.ceil((t.trialEndsAt - nowMs) / DAY)) };
    }
    case "active":
      return { state: "active", writable: true, seatLimit: PLAN.paidSeatLimit };
    case "past_due": {
      // 支払いの確認が取れないまま猶予期間を過ぎたら、閲覧のみにする
      const graceOver = t.pastDueSince !== undefined && nowMs > t.pastDueSince + PLAN.pastDueGraceDays * DAY;
      return { state: "past_due", writable: !graceOver, seatLimit: PLAN.paidSeatLimit };
    }
    case "canceled":
      return { state: "canceled", writable: false, seatLimit: PLAN.paidSeatLimit };
    case "suspended":
      return { state: "suspended", writable: false, seatLimit: 0 };
  }
}
