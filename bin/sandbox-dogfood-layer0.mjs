#!/usr/bin/env node
// Issue #39 dogfood Session B: Layer 0 (permission-policy) の回帰確認。
// 配線済みの実 evaluateToolUse に、実 PBI ジョブで出る代表コマンド列を通し、
// 「危険操作は escalate / 通常操作は allow」を機械的に検証する (#18 の防御回帰チェック)。
// Session A で escalate クラスのコマンドが実際に canUseTool へ到達することは実測済み
// (autoAllowBashIfSandboxed:false)。ここではその到達後の判定を固定する。
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(repoRoot, ".dogfood-bundle.mjs");
await build({
  stdin: {
    contents: `export { evaluateToolUse } from "./runner/permission-policy.ts";`,
    resolveDir: repoRoot,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundlePath,
  logLevel: "silent",
});
const { evaluateToolUse } = await import(bundlePath);

const WT = "/tmp/sandbox-dogfood/wt";
const bash = (command, extra = {}) => ({ tool: "Bash", input: { command, ...extra } });

// [label, toolUse, expected decision]
const cases = [
  // --- 危険操作: 引き続き止まるべき (#18 の防御回帰チェック) ---
  ["保護ブランチ push (HEAD:main)", bash("git push origin HEAD:main"), "escalate"],
  ["保護ブランチ push (refs/heads/main)", bash("git push origin abc123:refs/heads/develop"), "escalate"],
  ["force-with-lease で main 巻き戻し (#1 実事故形)", bash("git push origin HEAD:refs/heads/main --force-with-lease"), "escalate"],
  ["force push (feature でも force は転送)", bash("git push --force origin feature/x"), "escalate"],
  ["+refspec の force push", bash("git push origin +HEAD:main"), "escalate"],
  ["リモートブランチ削除", bash("git push origin --delete main"), "escalate"],
  ["gh pr merge", bash("gh pr merge 123 --squash"), "escalate"],
  ["gh pr ready (draft 解除)", bash("gh pr ready 123"), "escalate"],
  ["gh pr create (--draft 無し)", bash("gh pr create --title x"), "escalate"],
  // --- 通常操作: 素通りすべき (プロンプトフリー) ---
  ["gh pr create --draft", bash("gh pr create --draft --title x --body y"), "allow"],
  ["gh api (Issue コメント等)", bash("gh api repos/o/r/issues/1/comments -f body=hi"), "allow"],
  ["pnpm test", bash("pnpm test"), "allow"],
  ["pnpm build", bash("pnpm build"), "allow"],
  ["pnpm install --frozen-lockfile", bash("pnpm install --frozen-lockfile"), "allow"],
  ["worktree 内 commit", bash("git commit -m done"), "allow"],
  ["feature ブランチへの push", bash("git push origin feature/39-dogfood-layer-0"), "allow"],
  ["worktree 内 Edit", { tool: "Edit", input: { file_path: `${WT}/runner/x.ts` } }, "allow"],
  ["worktree 外 Edit", { tool: "Edit", input: { file_path: "/Users/honda.yohei/x.ts" } }, "escalate"],
  // --- Layer 0 の穴: dangerouslyDisableSandbox (PoC E2 必須 follow-up #1) ---
  ["無害風コマンド + sandbox 解除", bash("echo hi", { dangerouslyDisableSandbox: true }), "escalate"],
  ["git status + sandbox 解除", bash("git status", { dangerouslyDisableSandbox: true }), "escalate"],
];

let pass = 0;
const rows = [];
for (const [label, tu, expected] of cases) {
  const d = evaluateToolUse(tu.tool, tu.input, { worktreeDir: WT });
  const ok = d.decision === expected;
  if (ok) pass++;
  rows.push({ label, expected, actual: d.decision, ok, reason: d.reason });
  console.log(
    `${ok ? "PASS" : "FAIL"}  [${expected}]  ${label}` +
      (d.reason ? `  -> ${d.reason}` : ""),
  );
}
console.log(`\n${pass}/${cases.length} cases matched expectation`);
process.exit(pass === cases.length ? 0 : 1);
