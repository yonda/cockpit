#!/usr/bin/env node
// Issue #36 PoC: macOS Seatbelt (sandbox) 実測ハーネス (使い捨て)
//
// query({ options: { sandbox } }) を実験ごとの設定で起動し、
// - canUseTool 呼び出し (評価順の観測点)
// - assistant の tool_use (Bash コマンドと dangerouslyDisableSandbox の有無)
// - tool_result (OS レベルの拒否メッセージの生データ)
// を JSONL で標準出力に流す。runner/ 本体には一切依存しない。
//
// 使い方: node bin/sandbox-poc.mjs <experiment> [cwd]
//   experiment: e1 | e1-noban | e2-off | e2-on | e3-tls | e3-excl | e4-pnpm | e5-git
//   cwd: 実験の作業ディレクトリ (省略時は実験定義のデフォルト)

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";

const log = (ev, data) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), ev, ...data }));

// 指定コマンドを 1 つずつ Bash で実行させる決定的なプロンプト。
// モデルには回避策・リトライを禁止し、結果の解釈はさせない (ログが一次情報)。
const runCommandsPrompt = (commands, extra = "") =>
  [
    "You are a sandbox test harness. Execute EXACTLY the following commands,",
    "one per Bash tool call, in order. Rules:",
    "- Do NOT modify the commands. Do NOT retry. Do NOT work around failures.",
    "- A failing command is an EXPECTED result: record it and move on.",
    "- Never set dangerouslyDisableSandbox unless a command line explicitly says so.",
    extra,
    "",
    ...commands.map((c, i) => `${i + 1}. ${c}`),
    "",
    "After running all commands, reply with one line per command:",
    "`<n>: OK` or `<n>: FAIL <short reason>` and stop.",
  ].join("\n");

const scratch = (name) => {
  const dir = `/tmp/sandbox-poc/${name}`;
  mkdirSync(dir, { recursive: true });
  return dir;
};

const HOME = process.env.HOME;

const EXPERIMENTS = {
  // E0: failIfUnavailable の実測用ミニ実験。ネストした sandbox-exec 配下など
  // Seatbelt が起動できない環境で実行し、デフォルト (true) と
  // POC_FAIL_IF_UNAVAILABLE=false の挙動差を観測する。
  e0: {
    cwd: () => scratch("e0"),
    sandbox: { enabled: true },
    commands: () => [
      `echo probe > ${HOME}/sandbox-poc-e0-probe.txt && echo WROTE-OUTSIDE-HOME || echo denied`,
      `env | grep -c SANDBOX_RUNTIME || echo no-sandbox-env`,
    ],
  },
  // E1: 最小構成。worktree(cwd) 外書き込みと未許可ドメイン egress が
  // OS レベルで弾かれるかの実測。
  e1: {
    cwd: () => scratch("e1"),
    sandbox: { enabled: true },
    commands: (cwd) => [
      `echo inside > ${cwd}/inside.txt && cat ${cwd}/inside.txt`,
      `echo outside > ${HOME}/sandbox-poc-e1-outside.txt`,
      `echo tmp-outside > /tmp/sandbox-poc-e1-outside-cwd.txt`,
      `mkdir -p ${HOME}/sandbox-poc-e1-dir`,
      `cat ${HOME}/.gitconfig | head -3`,
      `curl -sS --max-time 15 https://example.com -o /dev/null -w '%{http_code}\\n'`,
      `curl -sS --max-time 15 https://api.github.com/zen`,
      `env | grep -iE 'proxy|sandbox' || echo no-proxy-env`,
    ],
  },
  // E1-deny: SandboxNetworkAccess を canUseTool で deny した場合と、
  // プロキシを迂回した直接 egress が OS レベルで弾かれるかの実測。
  // POC_DENY_NET=1 で実行する。
  "e1-deny": {
    cwd: () => scratch("e1-deny"),
    sandbox: { enabled: true },
    commands: () => [
      `curl -sS --max-time 15 https://example.com -o /dev/null -w '%{http_code}\\n'`,
      `curl -sS --noproxy '*' --max-time 15 https://example.com -o /dev/null -w '%{http_code}\\n'`,
      `python3 -c "import socket; s=socket.create_connection(('93.184.215.14',443),timeout=10); print('raw tcp ok')"`,
    ],
  },
  // E2-off: autoAllowBashIfSandboxed: false → Bash が必ず canUseTool を通るか
  "e2-off": {
    cwd: () => scratch("e2-off"),
    sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
    commands: (cwd) => [
      `echo hello-off > ${cwd}/a.txt`,
      `ls ${cwd}`,
      `git status`,
      `cd ${cwd} && git init -q -b main && git commit -q --allow-empty -m init && git push origin main --force`,
    ],
  },
  // E2-on: autoAllowBashIfSandboxed: true → canUseTool バイパスの有無、
  // sandbox 化できないコマンドのフォールバック先
  "e2-on": {
    cwd: () => scratch("e2-on"),
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    commands: (cwd) => [
      `echo hello-on > ${cwd}/a.txt`,
      `ls ${cwd}`,
      `echo outside-on > ${HOME}/sandbox-poc-e2-outside.txt`,
      // sandbox 内で失敗した後、モデルが dangerouslyDisableSandbox に
      // フォールバックしたときの経路を観測する (明示指示で 1 回だけ許可)
      `echo escape-hatch > ${HOME}/sandbox-poc-e2-escape.txt  (this one only: if it fails sandboxed, retry ONCE with dangerouslyDisableSandbox: true)`,
    ],
  },
  // E3-tls: Seatbelt 下の gh の TLS 挙動 (excludedCommands なし)
  "e3-tls": {
    cwd: () => scratch("e3-tls"),
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    commands: () => [
      `gh api /rate_limit --jq '.resources.core.remaining'`,
      `gh api user --jq .login`,
      `gh pr list --repo yonda/cockpit --limit 1`,
      `curl -sS --max-time 15 https://api.github.com/zen`,
    ],
  },
  // E3-excl: excludedCommands: ["gh *"] で回避できるか +
  // excluded な gh が canUseTool 経由に戻るか (autoAllow: true のまま観測)
  "e3-excl": {
    cwd: () => scratch("e3-excl"),
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      excludedCommands: ["gh *"],
    },
    commands: () => [
      `gh api /rate_limit --jq '.resources.core.remaining'`,
      `gh api user --jq .login`,
      `gh pr list --repo yonda/cockpit --limit 1`,
      `echo excluded-check done`,
    ],
  },
  // E3-push: sandbox 下の git push (https + osxkeychain 認証) が通るか。
  // --dry-run なのでリモートには何も作らない。cwd は実 worktree を渡す。
  "e3-push": {
    cwd: null,
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    commands: (cwd) => [
      `cd ${cwd} && git fetch origin main`,
      `cd ${cwd} && git push --dry-run origin HEAD:refs/heads/sandbox-poc-probe`,
    ],
  },
  // E4: pnpm install / build / test に必要な egress の実測。
  // allowedDomains を段階的に与えて失敗ログからドメインを洗い出す。
  // 引数 cwd に package.json を用意した scratch dir を渡す。
  "e4-pnpm": {
    cwd: () => scratch("e4-pnpm"),
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: (process.env.POC_ALLOWED_DOMAINS ?? "registry.npmjs.org")
          .split(",")
          .filter(Boolean),
      },
    },
    commands: (cwd) => [
      `cd ${cwd} && rm -rf node_modules && pnpm install --reporter=append-only 2>&1 | tail -30`,
      `cd ${cwd} && node -e "require('date-fns'); console.log('require ok')"`,
    ],
  },
  // E4-repo: 実リポジトリ (cockpit worktree) での pnpm install / test / lint。
  // cwd に実 worktree を渡す。
  "e4-repo": {
    cwd: null,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: (process.env.POC_ALLOWED_DOMAINS ?? "registry.npmjs.org")
          .split(",")
          .filter(Boolean),
      },
    },
    commands: (cwd) => [
      `cd ${cwd} && pnpm install --frozen-lockfile --reporter=append-only 2>&1 | tail -10`,
      `cd ${cwd} && pnpm test 2>&1 | tail -12`,
      `cd ${cwd} && pnpm lint 2>&1 | tail -8`,
    ],
  },
  // E4-tests: sandbox 下で落ちるテストの特定 (E4-repo の深掘り)
  "e4-tests": {
    cwd: null,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ["registry.npmjs.org"] },
    },
    commands: (cwd) => [
      `cd ${cwd} && pnpm vitest run runner/__tests__/server.test.ts 2>&1 | grep -B2 -A8 'Uncaught Exception' | head -30`,
      `cd ${cwd} && pnpm vitest run 2>&1 | tail -8`,
    ],
  },
  // E4-build: sandbox 下での pnpm build (next build) / build:runner (esbuild)
  "e4-build": {
    cwd: null,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: (process.env.POC_ALLOWED_DOMAINS ?? "registry.npmjs.org")
          .split(",")
          .filter(Boolean),
      },
    },
    commands: (cwd) => [
      `curl -sS --max-time 15 'https://fonts.googleapis.com/css2?family=Manrope' -o /dev/null -w '%{http_code}\\n'`,
      `cd ${cwd} && pnpm build 2>&1 | tail -12`,
      `cd ${cwd} && pnpm build:runner 2>&1 | tail -5`,
    ],
  },
  // E5: リンク worktree からの共有 .git 書き込み (git commit / branch 更新)。
  // 引数 cwd にリンク worktree のパスを渡す (setup は呼び出し側スクリプトで行う)。
  "e5-git": {
    cwd: null, // 必ず引数で渡す
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    commands: (cwd) => [
      `cd ${cwd} && git status --short --branch`,
      `cd ${cwd} && echo change-$RANDOM >> file.txt && git add file.txt`,
      `cd ${cwd} && git commit -m poc-commit`,
      `cd ${cwd} && git branch poc-branch-probe`,
      `cd ${cwd} && git log --oneline -2`,
    ],
  },
};

const name = process.argv[2];
const exp = EXPERIMENTS[name];
if (!exp) {
  console.error(`unknown experiment: ${name}`);
  console.error(`available: ${Object.keys(EXPERIMENTS).join(", ")}`);
  process.exit(1);
}
const cwd = process.argv[3] ?? (exp.cwd ? exp.cwd() : null);
if (!cwd) {
  console.error("this experiment requires an explicit cwd argument");
  process.exit(1);
}

// filesystem 等の追加設定を環境変数で注入できるようにする (E5 の allowWrite 実測用)
const extraFsAllowWrite = process.env.POC_ALLOW_WRITE?.split(",").filter(Boolean);
const sandbox = structuredClone(exp.sandbox);
if (extraFsAllowWrite?.length) {
  sandbox.filesystem = { ...(sandbox.filesystem ?? {}), allowWrite: extraFsAllowWrite };
}
// UDS / localhost bind の実測用 (POC_ALLOW_LOCAL_BINDING=1 / POC_ALLOW_ALL_UNIX_SOCKETS=1)
if (process.env.POC_ALLOW_LOCAL_BINDING === "1") {
  sandbox.network = { ...(sandbox.network ?? {}), allowLocalBinding: true };
}
if (process.env.POC_ALLOW_ALL_UNIX_SOCKETS === "1") {
  sandbox.network = { ...(sandbox.network ?? {}), allowAllUnixSockets: true };
}
// failIfUnavailable の実測用 (POC_FAIL_IF_UNAVAILABLE=false / true)
if (process.env.POC_FAIL_IF_UNAVAILABLE) {
  sandbox.failIfUnavailable = process.env.POC_FAIL_IF_UNAVAILABLE === "true";
}
// SandboxNetworkAccess を deny する実験モード (POC_DENY_NET=1)
const denyNet = process.env.POC_DENY_NET === "1";

log("start", { experiment: name, cwd, sandbox });

const stream = query({
  prompt: runCommandsPrompt(exp.commands(cwd)),
  options: {
    cwd,
    sandbox,
    // runner と同じく canUseTool を持つ構成で評価順を観測する。
    // default-allow: 呼ばれたことをログして常に許可 (scratch dir 前提の PoC)。
    canUseTool: async (toolName, input) => {
      log("canUseTool", { toolName, input });
      if (denyNet && toolName === "SandboxNetworkAccess") {
        return { behavior: "deny", message: "PoC: network egress denied" };
      }
      return { behavior: "allow", updatedInput: input };
    },
    permissionMode: "default",
    settingSources: [], // ユーザー/プロジェクト設定を混ぜない (SDK isolation)
    maxTurns: 40,
    stderr: (data) => log("stderr", { data: data.slice(0, 2000) }),
  },
});

const truncate = (s, n = 1500) =>
  typeof s === "string" && s.length > n ? s.slice(0, n) + "…[truncated]" : s;

for await (const message of stream) {
  if (message.type === "system" && message.subtype === "init") {
    log("init", { session_id: message.session_id, model: message.model });
  } else if (message.type === "assistant") {
    for (const block of message.message.content ?? []) {
      if (block.type === "tool_use") {
        log("tool_use", { name: block.name, input: block.input });
      } else if (block.type === "text") {
        log("assistant_text", { text: truncate(block.text) });
      }
    }
  } else if (message.type === "user") {
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          const body = Array.isArray(block.content)
            ? block.content
                .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
                .join("\n")
            : block.content;
          log("tool_result", { is_error: block.is_error ?? false, body: truncate(body) });
        }
      }
    }
  } else if (message.type === "result") {
    log("result", {
      subtype: message.subtype,
      num_turns: message.num_turns,
      total_cost_usd: message.total_cost_usd,
    });
  }
}
