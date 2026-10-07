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
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 423 | 429 | 502 | 503,
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

/** URLやリンクに見える文字列か（全角を半角にそろえてから判定する。短縮URL・ドメイン名の羅列・[.] のような書き換えも拒否） */
export function looksLikeLink(v: string): boolean {
  const n = v.normalize("NFKC");
  if (/https?:|www\.|:\/\//i.test(n)) return true;
  if (/[a-z0-9-]+\.[a-z]{2,}\/\S/i.test(n)) return true; // ドメイン名のあとにパスが続く形（evil.example/login など）
  return /[a-z0-9-]+\s*(\.|\[\.\]|\(\.\)|dot)\s*(com|net|org|jp|io|ly|co|xyz|top|biz|info|me|cc|tk|ru|cn|app|dev|link|site|online|shop|gl|to|cx|us|de|uk)\b/i.test(n);
}

/** 1行の名前。改行などの制御文字とURLは受け付けない（案内メールの本文にそのまま入るため、第三者への悪用を防ぐ） */
export const plainLine = (label: string, max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min, `${label}を入力してください`)
    .max(max, `${label}は${max}文字以内で入力してください`)
    .refine((v) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v), `${label}に使えない文字が含まれています`)
    .refine((v) => !looksLikeLink(v), `${label}にURLは入力できません`);
