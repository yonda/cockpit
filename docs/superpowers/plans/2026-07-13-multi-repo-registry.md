# マルチリポジトリ対応（リポジトリレジストリ）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** runner を単一リポジトリ専用からレジストリ駆動の複数リポジトリ対応へ拡張し、外部 org の実 PBI を HerdrExecutor で回せるようにする。

**Architecture:** `~/.config/cockpit/repos.json` のレジストリが repo → { path, baseBranch, tokenOwner } を解決。認証は owner 別トークンファイル `~/.config/cockpit/tokens/<owner>` をジョブ単位で解決し、その git/gh 呼び出し・herdr ペインにのみ渡す（グローバル GH_TOKEN 撤廃）。cockpit 自身もレジストリの 1 エントリにして経路を一本化する。

**Tech Stack:** TypeScript / Node.js / vitest / esbuild bundle (dist/runner.cjs) / gh CLI / herdr CLI

## Global Constraints

- **公開リポジトリ**: コード・テスト・コミットメッセージに実在の会社名・org 名・個人名・絶対 home パス・個人トークンを一切含めない。テストはプレースホルダ（`acme/widget`, `/wt/x` 等）を使う。
- **fail-closed 認証**: トークン欠如・空・複数行は throw。未登録リポジトリの実行は失敗させる。keyring の強いトークンへ silent fallback しない。
- **グローバル GH_TOKEN 不使用**: owner ごとに異なるため、ジョブ単位で解決してその呼び出しにのみ渡す。`process.env.GH_TOKEN` を boot で設定しない。
- **ツール**: パッケージは pnpm（npm 不可）。nx タスクは `NX_DAEMON=false`。
- **テスト実行**: `NX_DAEMON=false pnpm vitest run <path>`。型チェックは `npx tsc --noEmit`。runner ビルドは `pnpm build:runner`。

---

### Task 1: CommandRunner に env 上書きを追加

呼び出しごとに環境変数を注入できるようにする。owner の異なるジョブが並行してもトークンが混ざらない基盤。

**Files:**
- Modify: `runner/exec.ts`
- Test: `runner/__tests__/exec.test.ts`（新規）

**Interfaces:**
- Produces: `CommandRunner.run(cmd, args, opts: { cwd: string; env?: Record<string, string> }): Promise<RunResult>` — `env` は既定 `process.env` にマージされる（上書き）。

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/exec.test.ts
import { describe, expect, it } from "vitest";
import { RealCommandRunner } from "../exec";

describe("RealCommandRunner env override", () => {
  it("opts.env が子プロセスに渡り process.env にマージされる", async () => {
    const runner = new RealCommandRunner();
    const { stdout } = await runner.run(
      "sh",
      ["-c", "echo $COCKPIT_TEST_VAR"],
      { cwd: process.cwd(), env: { COCKPIT_TEST_VAR: "hello" } },
    );
    expect(stdout.trim()).toBe("hello");
  });

  it("env 未指定でも従来どおり動く", async () => {
    const runner = new RealCommandRunner();
    const { stdout } = await runner.run("echo", ["ok"], { cwd: process.cwd() });
    expect(stdout.trim()).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/exec.test.ts`
Expected: FAIL（型エラー or COCKPIT_TEST_VAR 未定義で空）

- [ ] **Step 3: Implement**

```typescript
// runner/exec.ts — CommandRunner interface と RealCommandRunner を置換
export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<RunResult>;
}

export class RealCommandRunner implements CommandRunner {
  async run(
    cmd: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ) {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    return { stdout, stderr };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/exec.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck（既存呼び出しは opts に env 追加でも後方互換なので通るはず）**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: Commit**

```bash
git add runner/exec.ts runner/__tests__/exec.test.ts
git commit -m "feat(runner): CommandRunner.run に env 上書きを追加"
```

---

### Task 2: リポジトリレジストリ

`repos.json` を読み repo → 設定を解決する。未登録は null（呼び出し側で fail-closed）。

**Files:**
- Create: `runner/repo-registry.ts`
- Test: `runner/__tests__/repo-registry.test.ts`

**Interfaces:**
- Produces:
  - `type RepoConfig = { repo: string; path: string; baseBranch: string; tokenOwner: string }`
  - `class RepoRegistry { resolve(repo: string): RepoConfig | null; all(): RepoConfig[] }`
  - `function loadRegistry(file?: string): RepoRegistry` — 既定パスは `~/.config/cockpit/repos.json`、`COCKPIT_REPOS_FILE` で上書き。読めない/壊れているときは空レジストリを返す（デーモンは落とさない）。不正エントリ（path 非存在・必須欠如）は除外する。

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/repo-registry.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRegistry } from "../repo-registry";

let dir: string;
let existingRepoPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "repos-"));
  existingRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "repo-clone-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(existingRepoPath, { recursive: true, force: true });
});

function writeRepos(entries: unknown): string {
  const file = path.join(dir, "repos.json");
  fs.writeFileSync(file, JSON.stringify({ repos: entries }));
  return file;
}

describe("loadRegistry", () => {
  it("登録リポジトリを解決する", () => {
    const file = writeRepos([
      { repo: "acme/widget", path: existingRepoPath, baseBranch: "develop", tokenOwner: "acme" },
    ]);
    const reg = loadRegistry(file);
    const cfg = reg.resolve("acme/widget");
    expect(cfg).toEqual({
      repo: "acme/widget",
      path: existingRepoPath,
      baseBranch: "develop",
      tokenOwner: "acme",
    });
  });

  it("未登録リポジトリは null", () => {
    const file = writeRepos([]);
    expect(loadRegistry(file).resolve("acme/widget")).toBeNull();
  });

  it("path が存在しないエントリは除外する", () => {
    const file = writeRepos([
      { repo: "acme/widget", path: "/no/such/dir", baseBranch: "main", tokenOwner: "acme" },
    ]);
    expect(loadRegistry(file).resolve("acme/widget")).toBeNull();
  });

  it("必須フィールド欠如のエントリは除外する", () => {
    const file = writeRepos([
      { repo: "acme/widget", path: existingRepoPath, baseBranch: "", tokenOwner: "acme" },
    ]);
    expect(loadRegistry(file).resolve("acme/widget")).toBeNull();
  });

  it("ファイルが無ければ空レジストリ (throw しない)", () => {
    const reg = loadRegistry(path.join(dir, "missing.json"));
    expect(reg.all()).toEqual([]);
    expect(reg.resolve("acme/widget")).toBeNull();
  });

  it("壊れた JSON でも空レジストリ", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ not json");
    expect(loadRegistry(file).all()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/repo-registry.test.ts`
Expected: FAIL（loadRegistry 未定義）

- [ ] **Step 3: Implement**

```typescript
// runner/repo-registry.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type RepoConfig = {
  repo: string;
  path: string;
  baseBranch: string;
  tokenOwner: string;
};

const DEFAULT_REPOS_FILE = path.join(
  os.homedir(),
  ".config",
  "cockpit",
  "repos.json",
);

// エントリが有効か: 必須フィールドが非空文字列で、path が実在するディレクトリ。
function isValid(entry: unknown): entry is RepoConfig {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  for (const k of ["repo", "path", "baseBranch", "tokenOwner"]) {
    if (typeof e[k] !== "string" || (e[k] as string).length === 0) return false;
  }
  try {
    return fs.statSync(e.path as string).isDirectory();
  } catch {
    return false;
  }
}

export class RepoRegistry {
  private readonly byRepo = new Map<string, RepoConfig>();
  constructor(configs: RepoConfig[]) {
    for (const c of configs) this.byRepo.set(c.repo, c);
  }
  resolve(repo: string): RepoConfig | null {
    return this.byRepo.get(repo) ?? null;
  }
  all(): RepoConfig[] {
    return [...this.byRepo.values()];
  }
}

// repos.json を読む。読めない・壊れている・不正エントリは握りつぶして (ログ)、
// 有効なエントリだけのレジストリを返す。デーモン全体は落とさない
// (未登録リポジトリの job.fire は呼び出し側が fail-closed で失敗させる)。
export function loadRegistry(
  file: string = process.env.COCKPIT_REPOS_FILE || DEFAULT_REPOS_FILE,
): RepoRegistry {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return new RepoRegistry([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[runner] repos.json のパースに失敗: ${file}`);
    return new RepoRegistry([]);
  }
  const repos = (parsed as { repos?: unknown }).repos;
  if (!Array.isArray(repos)) return new RepoRegistry([]);
  const valid: RepoConfig[] = [];
  for (const entry of repos) {
    if (isValid(entry)) {
      valid.push(entry);
    } else {
      console.error(`[runner] repos.json の無効なエントリを無視: ${JSON.stringify(entry)}`);
    }
  }
  return new RepoRegistry(valid);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/repo-registry.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add runner/repo-registry.ts runner/__tests__/repo-registry.test.ts
git commit -m "feat(runner): リポジトリレジストリ (repos.json) を追加"
```

---

### Task 3: owner 別トークン解決

`~/.config/cockpit/tokens/<owner>` を読む。既存の `loadRunnerToken`（ファイル読み + fail-closed 検証）を再利用する。

**Files:**
- Modify: `runner/github-token.ts`
- Test: `runner/__tests__/github-token.test.ts`（既存に追記）

**Interfaces:**
- Consumes: `loadRunnerToken(filePath): string`（既存）
- Produces: `function resolveToken(owner: string, tokensDir?: string): string` — `<tokensDir>/<owner>` を読む。既定 `~/.config/cockpit/tokens`、`COCKPIT_TOKENS_DIR` で上書き。欠如・空・複数行は throw（loadRunnerToken 準拠）。

- [ ] **Step 1: Write the failing test**（既存 github-token.test.ts の末尾に追記）

```typescript
// runner/__tests__/github-token.test.ts の describe を追加
import { resolveToken } from "../github-token";

describe("resolveToken", () => {
  let tokensDir: string;
  beforeEach(() => {
    tokensDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokens-"));
  });
  afterEach(() => {
    fs.rmSync(tokensDir, { recursive: true, force: true });
  });

  it("owner のトークンファイルを読む", () => {
    fs.writeFileSync(path.join(tokensDir, "acme"), "github_pat_acme\n");
    expect(resolveToken("acme", tokensDir)).toBe("github_pat_acme");
  });

  it("owner のトークンが無ければ throw (fail-closed)", () => {
    expect(() => resolveToken("acme", tokensDir)).toThrow();
  });

  it("COCKPIT_TOKENS_DIR で既定ディレクトリを上書きできる", () => {
    fs.writeFileSync(path.join(tokensDir, "acme"), "github_pat_acme\n");
    const prev = process.env.COCKPIT_TOKENS_DIR;
    process.env.COCKPIT_TOKENS_DIR = tokensDir;
    try {
      expect(resolveToken("acme")).toBe("github_pat_acme");
    } finally {
      if (prev === undefined) delete process.env.COCKPIT_TOKENS_DIR;
      else process.env.COCKPIT_TOKENS_DIR = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/github-token.test.ts`
Expected: FAIL（resolveToken 未定義）

- [ ] **Step 3: Implement**（github-token.ts に追加。既存 applyRunnerToken は Task 7 で撤去するため、この時点では残す）

```typescript
// runner/github-token.ts に追加
import * as path from "node:path"; // 既存

const DEFAULT_TOKENS_DIR = path.join(os.homedir(), ".config", "cockpit", "tokens");

/**
 * owner 別トークンを解決する。<tokensDir>/<owner> を読み、loadRunnerToken と同じ
 * fail-closed 検証 (欠如・空・複数行で throw) を通す。ジョブ単位で呼ぶ。
 */
export function resolveToken(
  owner: string,
  tokensDir: string = process.env.COCKPIT_TOKENS_DIR || DEFAULT_TOKENS_DIR,
): string {
  return loadRunnerToken(path.join(tokensDir, owner));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/github-token.test.ts`
Expected: PASS（既存 + 追加 3 件）

- [ ] **Step 5: Commit**

```bash
git add runner/github-token.ts runner/__tests__/github-token.test.ts
git commit -m "feat(runner): owner 別トークン解決 resolveToken を追加"
```

---

### Task 4: ExecutorRunOpts に githubToken を追加し HerdrExecutor で供給

herdr ペインは runner の env を継承しないため、ジョブの owner トークンをペイン起動コマンドに明示的に渡す。

**Files:**
- Modify: `runner/executor.ts`（ExecutorRunOpts）
- Modify: `runner/herdr-executor.ts`（startAgent 呼び出しに githubToken を渡す）
- Modify: `runner/herdr-real.ts`（RealHerdrClient.startAgent が GH_TOKEN を供給）
- Test: `runner/__tests__/herdr-executor.test.ts`（既存に追記）

**Interfaces:**
- Produces: `ExecutorRunOpts.githubToken: string | null`
- HerdrClient.startAgent の opts に `githubToken: string | null` を追加

- [ ] **Step 1: Write the failing test**（herdr-executor.test.ts に追記）

```typescript
it("githubToken を startAgent に渡す", async () => {
  const fakes = makeFakes({});
  const exec = new HerdrExecutor(makeDeps(fakes));
  await exec.run(makeOpts({ githubToken: "tok-xyz" }), makeHooks());
  expect(fakes.herdr.startCalls[0].githubToken).toBe("tok-xyz");
});
```

（`makeOpts` の既定に `githubToken: null` を追加、fake の `startAgent` が受けた opts に `githubToken` が含まれるよう型を更新）

- [ ] **Step 2: Run test to verify it fails**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/herdr-executor.test.ts`
Expected: FAIL（githubToken 未定義）

- [ ] **Step 3: Implement**

```typescript
// runner/executor.ts の ExecutorRunOpts に追加
export type ExecutorRunOpts = {
  cwd: string;
  prompt: string;
  resumeSessionId: string | null;
  githubToken: string | null; // 対象リポジトリ owner のトークン (herdr ペイン等へ供給)
  signal: AbortSignal;
};
```

```typescript
// runner/herdr-executor.ts の HerdrClient.startAgent 型に githubToken を追加
startAgent(
  paneId: string,
  opts: {
    cwd: string;
    settingsPath: string;
    prompt: string;
    resumeSessionId: string | null;
    githubToken: string | null;
  },
): Promise<void>;
```

```typescript
// runner/herdr-executor.ts の run() 内 startAgent 呼び出しに githubToken を渡す
await this.deps.herdr.startAgent(paneId, {
  cwd: opts.cwd,
  settingsPath: this.deps.settingsPath,
  prompt: opts.prompt,
  resumeSessionId: opts.resumeSessionId,
  githubToken: opts.githubToken,
});
```

```typescript
// runner/herdr-real.ts の RealHerdrClient.startAgent
// launch コマンドの先頭に GH_TOKEN を前置する (shellQuote 済み)。
const tokenPrefix = opts.githubToken
  ? `GH_TOKEN=${shellQuote(opts.githubToken)} `
  : "";
const launch = `cd ${shellQuote(opts.cwd)} && ${tokenPrefix}claude --settings ${shellQuote(
  opts.settingsPath,
)}${resumeFlag}`;
```

（`startAgent` の opts 型にも `githubToken: string | null` を追加）

- [ ] **Step 4: Run test to verify it passes**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/herdr-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck（sdk-executor / workflow が ExecutorRunOpts を作る箇所が githubToken 欠如でエラーになる。Task 5-6 で埋めるため、この時点では sdk-executor.ts の run 呼び出しに `githubToken: null` を仮で足しておく）**

```typescript
// runner/workflow.ts の deps.executor.run({...}) 呼び出しに一旦
githubToken: null,
// を追加 (Task 6 で実トークンに差し替え)
```

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: Commit**

```bash
git add runner/executor.ts runner/herdr-executor.ts runner/herdr-real.ts runner/workflow.ts runner/__tests__/herdr-executor.test.ts
git commit -m "feat(runner): ExecutorRunOpts.githubToken を herdr ペインへ供給"
```

---

### Task 5: SdkExecutor に githubToken を渡す

分解ジョブ・SDK 実装経路でも対象リポジトリのトークンを子プロセスに渡す。

**Files:**
- Modify: `runner/sdk-executor.ts`
- Test: `runner/__tests__/sdk-executor.test.ts`（既存に追記、query の options に env が入ることを検証）

**Interfaces:**
- Consumes: `ExecutorRunOpts.githubToken`

- [ ] **Step 1: Write the failing test**（sdk-executor.test.ts、mockQuery に渡る options を検証）

```typescript
it("githubToken を query の env.GH_TOKEN に渡す", async () => {
  mockQuery.mockReturnValue((async function* () {
    yield { type: "result", subtype: "success", session_id: "s" };
  })());
  const exec = new SdkExecutor();
  await exec.run(
    { cwd: "/wt", prompt: "p", resumeSessionId: null, githubToken: "tok-1", signal: new AbortController().signal },
    { onSessionId() {}, onActivity() {}, requestInput: async () => ({ kind: "allow" }) },
  );
  const opts = mockQuery.mock.calls[0][0].options;
  expect(opts.env.GH_TOKEN).toBe("tok-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/sdk-executor.test.ts`
Expected: FAIL（env 未設定）

- [ ] **Step 3: Implement**（sdk-executor.ts の query options に env を追加）

```typescript
// runner/sdk-executor.ts の query({ options: {...} }) に追加
env: opts.githubToken
  ? { ...process.env, GH_TOKEN: opts.githubToken }
  : process.env,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/sdk-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner/sdk-executor.ts runner/__tests__/sdk-executor.test.ts
git commit -m "feat(runner): SdkExecutor に githubToken (env.GH_TOKEN) を配線"
```

---

### Task 6: workflow を per-repo（path / baseBranch / token）に配線

`WorkflowDeps` にレジストリとトークン解決を持たせ、ジョブの repo から config・token を解決して worktree・git・executor に反映する。

**Files:**
- Modify: `runner/workflow.ts`
- Test: `runner/__tests__/workflow.test.ts`（既存に追記）

**Interfacesः**
- Consumes: `RepoRegistry.resolve`, `resolveToken`, `CommandRunner.run(..., { env })`, `ExecutorRunOpts.githubToken`
- Produces: `WorkflowDeps` から `repoDir: string` を除去し、`registry: RepoRegistry` と `resolveToken: (owner: string) => string` を追加。

- [ ] **Step 1: Write the failing test**（workflow.test.ts、未登録 repo で fail-closed、baseBranch が worktree add に反映）

```typescript
it("未登録リポジトリのジョブは failed になる", async () => {
  // registry.resolve が null を返すジョブを流し、store が failed に遷移することを検証
  // (既存テストの deps 組み立てを registry/resolveToken 付きに更新する)
});

it("worktree add が origin/<baseBranch> を起点にする", async () => {
  // registry が baseBranch: "develop" を返すとき、commands.run の worktree add 引数に
  // "origin/develop" が含まれることを検証
});
```

（既存 workflow.test.ts の fake CommandRunner とダミー deps を、`repoDir` 除去 + `registry`（fake）+ `resolveToken`（fake）に更新する。既存テストのブランチ作成・git config・push などの検証も、`registry.resolve` が返す `path` を cwd に使うよう追随させる）

- [ ] **Step 2: Run test to verify it fails**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/workflow.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// runner/workflow.ts
import type { RepoRegistry, RepoConfig } from "./repo-registry";

export type WorkflowDeps = {
  store: JobStore;
  broker: InputBroker;
  commands: CommandRunner;
  executor: AgentExecutor;
  registry: RepoRegistry;
  resolveToken: (owner: string) => string;
};

// ensureWorktree は RepoConfig を受け取り、config.path を cwd、
// origin/<config.baseBranch> を起点に使う。
async function ensureWorktree(
  deps: WorkflowDeps,
  config: RepoConfig,
  branch: string,
): Promise<string> {
  const repoDir = config.path;
  const list = async () => {
    const { stdout } = await deps.commands.run(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: repoDir },
    );
    return findWorktreePath(stdout, branch);
  };
  await deps.commands.run("git", ["config", "push.default", "current"], {
    cwd: repoDir,
  });
  const existing = await list();
  if (existing) return existing;
  const wtRoot = join(dirname(repoDir), `${basename(repoDir)}-wt`);
  const worktreePath = join(wtRoot, branch);
  const branchExists = await deps.commands
    .run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoDir,
    })
    .then(() => true)
    .catch(() => false);
  const addArgs = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", worktreePath, "-b", branch, `origin/${config.baseBranch}`];
  await deps.commands.run("git", addArgs, { cwd: repoDir });
  await deps.commands.run("pnpm", ["install"], { cwd: worktreePath });
  const created = await list();
  if (!created) throw new Error(`worktree not found after creating ${branch}`);
  return created;
}
```

```typescript
// runIssueJob の冒頭で repo を解決し、以降 deps.repoDir の代わりに config.path を使う。
const config = deps.registry.resolve(job.repo);
if (!config) {
  deps.store.transition(jobId, "failed", {
    error: `リポジトリが未登録です: ${job.repo} (~/.config/cockpit/repos.json に登録してください)`,
  });
  return;
}
let githubToken: string;
try {
  githubToken = deps.resolveToken(config.tokenOwner);
} catch (err) {
  deps.store.transition(jobId, "failed", {
    error: `owner ${config.tokenOwner} のトークン解決に失敗: ${err instanceof Error ? err.message : String(err)}`,
  });
  return;
}
```

- worktree 準備で `fetchOriginMain(deps.commands, deps.repoDir)` → `fetchOrigin(deps.commands, config.path, config.baseBranch)` に変更（git-fetch.ts のヘルパーを baseBranch 引数対応に。既存 `fetchOriginMain` は `fetchOrigin(commands, dir, "main")` として残すか置換）。
- `ensureWorktree(deps, config, job.branch)` を呼ぶ。
- `gh` 呼び出し（issue view / review_reply）の cwd を `config.path`、env に `{ GH_TOKEN: githubToken }` を渡す。
- `deps.executor.run({ cwd: worktreePath, prompt, resumeSessionId, githubToken, signal }, hooks)` に githubToken を渡す（Task 4 の仮 `null` を差し替え）。

- [ ] **Step 4: Run test to verify it passes**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/workflow.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: main.ts が旧 WorkflowDeps（repoDir）を渡していてエラー → Task 7 で解消。ここでは workflow/scheduler 内が通ることを確認（main.ts のエラーのみ残る）。

- [ ] **Step 6: Commit**

```bash
git add runner/workflow.ts runner/git-fetch.ts runner/__tests__/workflow.test.ts
git commit -m "feat(runner): workflow を per-repo (path/baseBranch/token) 配線に変更"
```

---

### Task 7: RealGitHubClient を per-repo トークンに

ポーリング等の gh 呼び出しも、対象 `repo` の owner トークンで動かす。

**Files:**
- Modify: `runner/github.ts`
- Test: `runner/__tests__/github.test.ts`（既存に追記）

**Interfaces:**
- Consumes: `resolveToken(owner)`
- `RealGitHubClient` のコンストラクタを `(commands, resolveToken: (owner: string) => string)` に変更（`repoDir` を除去）。各メソッドは引数の `repo` から owner を取り出しトークンを解決、`gh` を `{ cwd: <任意>, env: { GH_TOKEN } }` で実行。cwd はリポジトリ非依存で良いため `process.cwd()` を使う（gh は `--repo` で対象を指定済み）。

- [ ] **Step 1: Write the failing test**

```typescript
it("repo の owner トークンを解決して gh に渡す", async () => {
  const calls: Array<{ env?: Record<string, string> }> = [];
  const commands = {
    run: async (_c: string, _a: string[], opts: { cwd: string; env?: Record<string, string> }) => {
      calls.push({ env: opts.env });
      return { stdout: JSON.stringify({ title: "t", body: "b" }), stderr: "" };
    },
  };
  const client = new RealGitHubClient(commands, (owner) => `tok-${owner}`);
  await client.fetchIssue("acme/widget", 1);
  expect(calls[0].env?.GH_TOKEN).toBe("tok-acme");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/github.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// runner/github.ts
export class RealGitHubClient implements GitHubClient {
  constructor(
    private readonly commands: CommandRunner,
    private readonly resolveToken: (owner: string) => string,
  ) {}

  private gh(repo: string, args: string[]) {
    const owner = repo.split("/")[0];
    return this.commands.run("gh", args, {
      cwd: process.cwd(),
      env: { GH_TOKEN: this.resolveToken(owner) },
    });
  }
  // 各メソッドの this.gh([...]) 呼び出しを this.gh(repo, [...]) に変更する。
  // (fetchIssue/createSubIssue/updateIssueBody/closeIssue/prStateForBranch すべて repo を持つ)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NX_DAEMON=false pnpm vitest run runner/__tests__/github.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner/github.ts runner/__tests__/github.test.ts
git commit -m "feat(runner): RealGitHubClient を per-repo owner トークンに"
```

---

### Task 8: main.ts をレジストリ駆動に配線

boot で単一 REPO_DIR / グローバル GH_TOKEN を撤廃し、レジストリと resolveToken を配線する。

**Files:**
- Modify: `runner/main.ts`
- Modify: `runner/github-token.ts`（`applyRunnerToken` を削除）

**Interfaces:**
- Consumes: `loadRegistry`, `resolveToken`, 更新後の `WorkflowDeps` / `RealGitHubClient`

- [ ] **Step 1: Implement（main.ts）**

```typescript
// runner/main.ts
import { loadRegistry } from "./repo-registry";
import { resolveToken } from "./github-token";
// applyRunnerToken の import と呼び出しを削除

function main(): void {
  const registry = loadRegistry();
  const store = new JobStore(JOBS_DIR);
  store.loadAll();
  const broker = new InputBroker();
  const commands = new RealCommandRunner();

  let implementExecutor: AgentExecutor = new SdkExecutor();
  try {
    implementExecutor = buildHerdrExecutorFromEnv() ?? implementExecutor;
  } catch (err) {
    console.error(`[runner] HerdrExecutor 構築に失敗したため SdkExecutor に degrade します: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (implementExecutor.constructor.name === "HerdrExecutor") {
    console.log("[runner] implement executor: HerdrExecutor (herdr pane)");
  }

  const scheduler = new Scheduler({
    store, broker, commands,
    executor: implementExecutor,
    registry,
    resolveToken,
  });

  const pbiStore = new PbiStore(PBIS_DIR);
  pbiStore.loadAll();
  const github = new RealGitHubClient(commands, resolveToken);
  const exec: PbiExecutorDeps = { pbiStore, jobStore: store, scheduler, github };
  const lifecycle: LifecycleDeps = {
    store: pbiStore,
    executor: new SdkExecutor(),
    github,
    prepareCwd: realPrepareCwd(commands, registry), // realPrepareCwd の repoDir 依存を registry 対応に (下記)
  };
  // 以降既存どおり
}
```

（`buildHerdrExecutorFromEnv` の `repoDir` 引数を撤去し、settings パスは `path.join(process.cwd(), "runner", "herdr-runner-settings.json")` に。`realPrepareCwd`（decompose.ts）が `repoDir` を使っている場合は、分解対象リポジトリの config.path を使うよう registry 経由に更新する。分解ジョブ側の repo 解決は pbi-lifecycle の呼び出し経路に従う。）

- [ ] **Step 2: Implement（github-token.ts: applyRunnerToken 削除）**

`applyRunnerToken` 関数と関連コメントを削除。`loadRunnerToken` と `resolveToken` は残す。

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: エラーなし（decompose.ts / pbi-lifecycle の repoDir 経路も registry 対応に修正して解消）

- [ ] **Step 4: Full test suite**

Run: `NX_DAEMON=false pnpm vitest run`
Expected: 全 PASS

- [ ] **Step 5: Build**

Run: `pnpm build:runner`
Expected: dist/runner.cjs 生成、エラーなし

- [ ] **Step 6: Commit**

```bash
git add runner/main.ts runner/github-token.ts runner/decompose.ts runner/pbi-lifecycle.ts
git commit -m "feat(runner): main をレジストリ駆動に配線しグローバル GH_TOKEN を撤廃"
```

---

### Task 9: bin/service を owner 別トークンに対応

`runner-token-sync` と preflight を owner 別に拡張する。

**Files:**
- Modify: `bin/service`

**Interfaces:**
- `runner-token-sync <owner>`: 1Password から `~/.config/cockpit/tokens/<owner>` へ同期。
- `check_runner_token`: `~/.config/cockpit/tokens/` 配下の各ファイルを検証（少なくとも 1 つあること + 各々が有効）。

- [ ] **Step 1: Implement**

```bash
# bin/service の cmd_runner_token_sync を owner 別に:
cmd_runner_token_sync() {
  local owner="${1:?owner を指定してください (例: runner-token-sync yonda)}"
  local ref="${COCKPIT_RUNNER_TOKEN_OP_REF:-op://Private/cockpit-github-token-${owner}/password}"
  local dir="${COCKPIT_TOKENS_DIR:-$HOME/.config/cockpit/tokens}"
  local file="${dir}/${owner}"
  command -v op >/dev/null || { echo "op (1Password CLI) が見つかりません" >&2; exit 1; }
  mkdir -p "${dir}"
  rm -f "${file}"; install -m 600 /dev/null "${file}"
  if ! op read "${ref}" > "${file}"; then
    rm -f "${file}"; echo "op read に失敗: ${ref}" >&2; exit 1
  fi
  echo "synced ${ref} -> ${file}"
}

# check_runner_token: tokens/ 配下を全チェック
check_runner_token() {
  local dir="${COCKPIT_TOKENS_DIR:-$HOME/.config/cockpit/tokens}"
  if [[ ! -d "${dir}" ]] || [[ -z "$(ls -A "${dir}" 2>/dev/null)" ]]; then
    echo "runner-token: MISSING (${dir}/<owner> に fine-grained PAT を配置してください)"; return 1
  fi
  local ok=1
  for f in "${dir}"/*; do
    local tok; tok="$(<"${f}")"; tok="${tok#"${tok%%[![:space:]]*}"}"; tok="${tok%"${tok##*[![:space:]]}"}"
    if [[ -z "${tok}" || "${tok}" == *[[:space:]]* ]]; then
      echo "runner-token: INVALID ($(basename "${f}"))"; ok=0
    elif ! GH_TOKEN="${tok}" gh api rate_limit >/dev/null 2>&1; then
      echo "runner-token: NG ($(basename "${f}") — 認証失敗)"; ok=0
    else
      echo "runner-token: ok ($(basename "${f}"))"
    fi
  done
  return $ok  # 注: 1つでも NG なら非ゼロにするため、ok=0 のとき return 1 にする実装へ
}
```

（`return $ok` は 1=成功の意味で混乱するため、実装では `[[ $ok -eq 1 ]]` で分岐して `return 0/1` にする。case 文の `runner-token-sync)` は `$2` を owner として `cmd_runner_token_sync "$2"` に渡す。usage も更新。）

- [ ] **Step 2: Syntax check**

Run: `bash -n bin/service`
Expected: エラーなし

- [ ] **Step 3: 手動動作確認（throwaway owner で）**

```bash
COCKPIT_TOKENS_DIR=/tmp/cockpit-tokens-test bash -c '
  source <(sed -n "/^check_runner_token/,/^}/p" bin/service)
  mkdir -p /tmp/cockpit-tokens-test
  printf "bad-token\n" > /tmp/cockpit-tokens-test/acme
  check_runner_token; echo "rc=$?"
'
```
Expected: `runner-token: NG (acme — 認証失敗)` + rc 非ゼロ

- [ ] **Step 4: Commit**

```bash
git add bin/service
git commit -m "feat(service): runner-token-sync / preflight を owner 別トークンに対応"
```

---

## Self-Review 結果

- **Spec coverage**: レジストリ(T2) / owner 別トークン(T3,T9) / per-repo baseBranch(T6) / herdr・SDK へのトークン供給(T4,T5) / gh の per-repo トークン(T7) / cockpit 一本化・グローバル GH_TOKEN 撤廃(T8) / CommandRunner env(T1) — spec の各項目に対応タスクあり。
- **Placeholder scan**: テストは `acme/widget` 等プレースホルダのみ。TBD/TODO なし。
- **Type consistency**: `RepoConfig`(T2) / `resolveToken(owner, dir?)`(T3) / `ExecutorRunOpts.githubToken`(T4) / `WorkflowDeps{registry, resolveToken}`(T6) / `RealGitHubClient(commands, resolveToken)`(T7) を後続タスクで一貫使用。
- **注意点(実装時に解消)**: T6/T8 は既存 `repoDir` 依存(decompose.ts の realPrepareCwd, pbi-lifecycle)への波及があり、tsc を通しながら registry 経由に追随させる。分解ジョブの repo 解決経路は実装時にコードを読んで確定する。
