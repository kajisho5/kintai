import type { Context } from "hono";
import { z } from "zod";
import type { Employee, EmpBrief } from "../domain";
import type { Clock } from "./clock";
import type { Tenant } from "./control";
import type { Db } from "./db";
import type { Access } from "./plans";

export interface AppConfig {
  secureCookie: boolean;
  sessionHours: number;
  /** リバースプロキシの背後で X-Forwarded-For を信頼するか */
  trustProxy?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 423 | 429,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** ログイン済みリクエストで使える値。db は常にそのテナント 1 社分 */
export type Env = {
  Variables: { tenant: Tenant; db: Db; clock: Clock; me: Employee; access: Access };
};

export const COOKIE = "sid";

export const brief = (e: Pick<Employee, "id" | "name" | "dept" | "title" | "kind">): EmpBrief => ({
  id: e.id,
  name: e.name,
  dept: e.dept,
  title: e.title,
  kind: e.kind,
});

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(400, r.error.issues[0]?.message ?? "入力が正しくありません");
  return r.data;
}

export const requireAdmin = (c: Context<Env>): Employee => {
  const me = c.get("me");
  if (me.role !== "admin") throw new ApiError(403, "この操作には管理者権限が必要です");
  return me;
};

export const pendingCount = (db: Db): number => (db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'").get() as { n: number }).n;

export const activeCount = (db: Db): number => (db.prepare("SELECT COUNT(*) AS n FROM employees WHERE active = 1").get() as { n: number }).n;
