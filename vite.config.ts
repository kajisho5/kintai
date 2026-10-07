import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { BRAND } from "./src/brand.ts";
import { PLAN } from "./src/pricing.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const yen = (n: number) => n.toLocaleString("en-US");

/** 公開サイト（site/*.html）の {{TOKEN}} を、製品名・料金・運営者情報で置き換える */
function siteTokens(): Plugin {
  const t: Record<string, string> = {
    BRAND_NAME: BRAND.name,
    TAGLINE: BRAND.tagline,
    OP_NAME: BRAND.operator.name,
    OP_REP: BRAND.operator.representative,
    OP_ADDR: BRAND.operator.address,
    OP_EMAIL: BRAND.operator.email,
    OP_PHONE: BRAND.operator.phone,
    PRICE: yen(PLAN.pricePerSeatJpy),
    PRICE_30: yen(PLAN.pricePerSeatJpy * 30),
    TRIAL_DAYS: String(PLAN.trialDays),
    GRACE_DAYS: String(PLAN.pastDueGraceDays),
    NOTICE_DAYS: String(BRAND.policy.noticeDays),
    RETENTION_DAYS: String(BRAND.policy.retentionDays),
    LIABILITY_MONTHS: String(BRAND.policy.liabilityMonths),
  };
  return {
    name: "site-tokens",
    transformIndexHtml(html) {
      return html.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k: string) => t[k] ?? m);
    },
  };
}

export default defineConfig({
  // アプリは /app/ 配下、公開サイト（LP・規約）は / 配下に置く
  base: "/app/",
  plugins: [react(), siteTokens()],
  // CSP（font-src 'self'）を保つため、フォントを data: URI にインライン化しない
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        app: here("./index.html"),
        home: here("./site/index.html"),
        terms: here("./site/terms.html"),
        privacy: here("./site/privacy.html"),
        tokushoho: here("./site/tokushoho.html"),
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { include: ["src/**/*.test.ts"] },
});
