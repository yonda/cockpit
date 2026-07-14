import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    // app / lib 側の純ロジック (.ts) テスト。
    // React コンポーネント (.tsx) は jsdom 未設定のため対象外。
    include: ["app/**/__tests__/**/*.test.ts", "lib/**/__tests__/**/*.test.ts"],
    passWithNoTests: true,
  },
});
