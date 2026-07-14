import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    // app 側の純ロジック (.ts) テスト。
    // React コンポーネント (.tsx) は jsdom 未設定のため対象外。
    include: ["app/**/__tests__/**/*.test.ts"],
    // 現状テスト対象は無い (runner 退役で単体テスト群を削除)。将来 app 側に
    // 純ロジックテストが増えたらここに載る。
    passWithNoTests: true,
  },
});
