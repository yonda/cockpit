import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    // runner の単体テストと、app 側の純ロジック (.ts) テスト。
    // React コンポーネント (.tsx) は jsdom 未設定のため対象外。
    include: [
      "runner/__tests__/**/*.test.ts",
      "app/**/__tests__/**/*.test.ts",
    ],
  },
});
