import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // gitignored build output (退役した runner の dist/runner.cjs 等が
    // wt.copyignored で worktree に混入すると lint を汚すため明示除外)。
    "dist/**",
  ]),
]);

export default eslintConfig;
