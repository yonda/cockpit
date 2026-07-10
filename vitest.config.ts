import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["runner/__tests__/**/*.test.ts"],
  },
});
