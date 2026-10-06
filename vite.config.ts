import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // CSP（font-src 'self'）を保つため、フォントを data: URI にインライン化しない
  build: { assetsInlineLimit: 0 },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { include: ["src/**/*.test.ts"] },
});
