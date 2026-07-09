# Launch Pad Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cockpit の `/launch` タブから Issue を⚡発射すると、runner デーモンが worktree 上で headless エージェントを実行して draft PR を作り、許可・質問は cockpit UI で回答できる。

**Architecture:** 3 プロセス構成。runner デーモン（`com.cockpit.runner`、unix ソケット `~/.cache/cockpit/runner.sock`）がジョブキュー・Agent SDK 実行・許可保留を持ち、状態を `~/.cache/cockpit/jobs/*.json` に永続化。Next.js は薄いプロキシ（`app/api/jobs/*`）と UI。ブラウザへは SSE。

**Tech Stack:** TypeScript / vitest / esbuild / @anthropic-ai/claude-agent-sdk / node:net（JSON lines over unix socket、`lib/herdr/` と同パターン）

**Spec:** `docs/superpowers/specs/2026-07-09-launch-pad-design.md`（このプランの正）

## Global Constraints

- Next.js は 16.2.10。**Next 側のコードを書く前に `node_modules/next/dist/docs/` の該当ガイドを読むこと**（AGENTS.md の指示。training data と API が違う）
- パッケージ管理は pnpm。npm は使わない
- runner のコード（`runner/**`）は Next.js のコードを import しない。共有は `lib/jobs/types.ts` のみ。逆方向は `lib/runner/client.ts` と `lib/jobs/types.ts` のみ許可
- runner 内の import は相対パス（`@/` alias は Next 専用）
- このリポジトリは public（github.com/yonda/cockpit）。個人情報・社名をコード/コミットに入れない
- コミットは直接 main 系ブランチへ（PR 運用なし）。コミットメッセージ末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 同時実行ジョブ数は最大 2（スペック合意値）
- ジョブ状態機械: `queued → running → waiting_input ⇄ running → done | failed | cancelled`

---

### Task 1: テスト基盤 + 共有型 + 状態遷移

**Files:**
- Create: `lib/jobs/types.ts`
- Create: `runner/__tests__/types.test.ts`
- Create: `vitest.config.ts`
- Modify: `package.json`（scripts.test / devDependencies）

**Interfaces:**
- Produces: `JobStatus`, `Job`, `PendingInput`, `PendingInputKind`, `PendingInputResponse`, `RunnerRequest`, `RunnerResponse`, `RunnerEvent`, `canTransition(from, to)`, `LAUNCH_REPO`, `RUNNER_SOCKET_PATH`, `JOBS_DIR` — 以降の全タスクがこれを import する

- [ ] **Step 1: vitest を導入**

```bash
pnpm add -D vitest
```

`vitest.config.ts` を作成:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["runner/__tests__/**/*.test.ts"],
  },
});
```

`package.json` の scripts に追加:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: 失敗するテストを書く**

`runner/__tests__/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canTransition } from "../../lib/jobs/types";

describe("canTransition", () => {
  it("allows the happy path", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "waiting_input")).toBe(true);
    expect(canTransition("waiting_input", "running")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
  });

  it("rejects transitions out of terminal states", () => {
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("failed", "queued")).toBe(false);
    expect(canTransition("cancelled", "running")).toBe(false);
  });

  it("rejects skipping queued -> done", () => {
    expect(canTransition("queued", "done")).toBe(false);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm vitest run runner/__tests__/types.test.ts`
Expected: FAIL（`lib/jobs/types` が存在しない）

- [ ] **Step 4: `lib/jobs/types.ts` を実装**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

// ---- 定数 -------------------------------------------------------------

export const LAUNCH_REPO = process.env.LAUNCH_REPO ?? "yonda/cockpit";
export const RUNNER_SOCKET_PATH =
  process.env.RUNNER_SOCKET_PATH ?? join(homedir(), ".cache", "cockpit", "runner.sock");
export const JOBS_DIR =
  process.env.RUNNER_JOBS_DIR ?? join(homedir(), ".cache", "cockpit", "jobs");

// ---- ジョブ状態機械 ------------------------------------------------------

export type JobStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "done"
  | "failed"
  | "cancelled";

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting_input", "done", "failed", "cancelled"],
  waiting_input: ["running", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// ---- 許可・質問の転送 ----------------------------------------------------

export type PendingInputKind = "permission" | "question";

export type PendingInput = {
  id: string;
  kind: PendingInputKind;
  toolName: string;
  /** canUseTool に渡ってきた input そのまま (UI が要約表示する) */
  input: unknown;
  createdAt: string;
};

export type PendingInputResponse =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  /** AskUserQuestion への回答。質問ごとに選択肢ラベルの配列 */
  | { kind: "answers"; answers: string[][] };

// ---- ジョブ --------------------------------------------------------------

export type Job = {
  id: string;
  repo: string; // "yonda/cockpit"
  issueNumber: number;
  issueTitle: string;
  branch: string; // feature/<n>-<slug>
  worktreePath: string | null;
  status: JobStatus;
  sessionId: string | null;
  pendingInput: PendingInput | null;
  prUrl: string | null;
  error: string | null;
  /** 直近のツール実行など、UI に出す 1 行アクティビティ */
  lastActivity: string | null;
  createdAt: string;
  updatedAt: string;
};

// ---- ソケットプロトコル (JSON lines) ---------------------------------------

export type RunnerRequest =
  | { id: string; method: "job.list"; params: Record<string, never> }
  | {
      id: string;
      method: "job.fire";
      params: { repo: string; issueNumber: number; issueTitle: string };
    }
  | { id: string; method: "job.cancel"; params: { jobId: string } }
  | {
      id: string;
      method: "job.respond";
      params: { jobId: string; inputId: string; response: PendingInputResponse };
    }
  | { id: string; method: "events.subscribe"; params: Record<string, never> };

export type RunnerResponse = {
  id: string;
  result?: unknown;
  error?: { message: string };
};

export type RunnerEvent = { event: "job.updated"; data: Job };
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm vitest run runner/__tests__/types.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 6: コミット**

```bash
git add lib/jobs/types.ts runner/__tests__/types.test.ts vitest.config.ts package.json pnpm-lock.yaml
git commit -m "feat: job types, state machine, and vitest setup for launch pad

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: JobStore（永続化 + イベント）

**Files:**
- Create: `runner/store.ts`
- Test: `runner/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `Job`, `JobStatus`, `canTransition` (Task 1)
- Produces: `class JobStore extends EventEmitter` —
  `constructor(dir: string)` / `loadAll(): void` / `list(): Job[]` / `get(id): Job | undefined` /
  `create(fields: { repo; issueNumber; issueTitle; branch }): Job` /
  `transition(id: string, to: JobStatus, patch?: Partial<Job>): Job`（不正遷移は throw）/
  `update(id: string, patch: Partial<Job>): Job`（status 変更禁止）。
  変更のたびに `emit("job", job)` + JSON ファイル永続化

- [ ] **Step 1: 失敗するテストを書く**

`runner/__tests__/store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../store";

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobs-"));
  store = new JobStore(dir);
  store.loadAll();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fields = {
  repo: "yonda/cockpit",
  issueNumber: 1,
  issueTitle: "test issue",
  branch: "feature/1-test-issue",
};

describe("JobStore", () => {
  it("creates a queued job and emits an event", () => {
    const events: string[] = [];
    store.on("job", (job) => events.push(job.status));
    const job = store.create(fields);
    expect(job.status).toBe("queued");
    expect(job.id).toMatch(/^job-/);
    expect(events).toEqual(["queued"]);
  });

  it("persists jobs across reload", () => {
    const job = store.create(fields);
    store.transition(job.id, "running");

    const reloaded = new JobStore(dir);
    reloaded.loadAll();
    expect(reloaded.get(job.id)?.status).toBe("running");
  });

  it("rejects invalid transitions", () => {
    const job = store.create(fields);
    store.transition(job.id, "running");
    store.transition(job.id, "done");
    expect(() => store.transition(job.id, "running")).toThrow(/invalid transition/);
  });

  it("update patches fields without touching status", () => {
    const job = store.create(fields);
    store.update(job.id, { sessionId: "sess-1" });
    expect(store.get(job.id)?.sessionId).toBe("sess-1");
    expect(store.get(job.id)?.status).toBe("queued");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run runner/__tests__/store.test.ts`
Expected: FAIL（`../store` が存在しない）

- [ ] **Step 3: `runner/store.ts` を実装**

```ts
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canTransition, type Job, type JobStatus } from "../lib/jobs/types";

export class JobStore extends EventEmitter {
  private jobs = new Map<string, Job>();

  constructor(private readonly dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
  }

  loadAll(): void {
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(
          readFileSync(join(this.dir, name), "utf8"),
        ) as Job;
        this.jobs.set(job.id, job);
      } catch {
        // 壊れたファイルはスキップ (起動を止めない)
      }
    }
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  create(fields: {
    repo: string;
    issueNumber: number;
    issueTitle: string;
    branch: string;
  }): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: `job-${Date.now()}-${randomUUID().slice(0, 8)}`,
      ...fields,
      worktreePath: null,
      status: "queued",
      sessionId: null,
      pendingInput: null,
      prUrl: null,
      error: null,
      lastActivity: null,
      createdAt: now,
      updatedAt: now,
    };
    this.save(job);
    return job;
  }

  transition(id: string, to: JobStatus, patch: Partial<Job> = {}): Job {
    const job = this.mustGet(id);
    if (!canTransition(job.status, to)) {
      throw new Error(`invalid transition: ${job.status} -> ${to} (${id})`);
    }
    return this.save({ ...job, ...patch, status: to });
  }

  update(id: string, patch: Partial<Job>): Job {
    const job = this.mustGet(id);
    if (patch.status && patch.status !== job.status) {
      throw new Error("use transition() to change status");
    }
    return this.save({ ...job, ...patch });
  }

  private mustGet(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job: ${id}`);
    return job;
  }

  private save(job: Job): Job {
    const next = { ...job, updatedAt: new Date().toISOString() };
    this.jobs.set(next.id, next);
    // 書きかけファイルを読まれないよう atomic write
    const path = join(this.dir, `${next.id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    this.emit("job", next);
    return next;
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run runner/__tests__/store.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: コミット**

```bash
git add runner/store.ts runner/__tests__/store.test.ts
git commit -m "feat: persistent job store with state-machine enforcement

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: InputBroker（許可保留の受け渡し）

**Files:**
- Create: `runner/input-broker.ts`
- Test: `runner/__tests__/input-broker.test.ts`

**Interfaces:**
- Consumes: `PendingInput`, `PendingInputResponse` (Task 1)
- Produces: `class InputBroker` —
  `request(jobId: string, input: PendingInput): Promise<PendingInputResponse>` /
  `resolve(jobId: string, inputId: string, response: PendingInputResponse): boolean` /
  `abort(jobId: string): void`（保留中なら deny で解決）

- [ ] **Step 1: 失敗するテストを書く**

`runner/__tests__/input-broker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InputBroker } from "../input-broker";
import type { PendingInput } from "../../lib/jobs/types";

const input: PendingInput = {
  id: "in-1",
  kind: "permission",
  toolName: "Bash",
  input: { command: "rm -rf node_modules" },
  createdAt: new Date().toISOString(),
};

describe("InputBroker", () => {
  it("resolves a pending request with the matching inputId", async () => {
    const broker = new InputBroker();
    const promise = broker.request("job-1", input);
    expect(broker.resolve("job-1", "in-1", { kind: "allow" })).toBe(true);
    await expect(promise).resolves.toEqual({ kind: "allow" });
  });

  it("ignores mismatched inputId", () => {
    const broker = new InputBroker();
    void broker.request("job-1", input);
    expect(broker.resolve("job-1", "in-999", { kind: "allow" })).toBe(false);
  });

  it("abort denies the pending request", async () => {
    const broker = new InputBroker();
    const promise = broker.request("job-1", input);
    broker.abort("job-1");
    await expect(promise).resolves.toEqual({
      kind: "deny",
      message: "job cancelled",
    });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run runner/__tests__/input-broker.test.ts`
Expected: FAIL（`../input-broker` が存在しない）

- [ ] **Step 3: `runner/input-broker.ts` を実装**

```ts
import type { PendingInput, PendingInputResponse } from "../lib/jobs/types";

type Pending = {
  inputId: string;
  resolve: (response: PendingInputResponse) => void;
};

/** canUseTool の Promise を保留し、UI からの回答で解決する受付台 */
export class InputBroker {
  private pending = new Map<string, Pending>();

  request(jobId: string, input: PendingInput): Promise<PendingInputResponse> {
    return new Promise((resolve) => {
      this.pending.set(jobId, { inputId: input.id, resolve });
    });
  }

  resolve(
    jobId: string,
    inputId: string,
    response: PendingInputResponse,
  ): boolean {
    const entry = this.pending.get(jobId);
    if (!entry || entry.inputId !== inputId) return false;
    this.pending.delete(jobId);
    entry.resolve(response);
    return true;
  }

  abort(jobId: string): void {
    const entry = this.pending.get(jobId);
    if (!entry) return;
    this.pending.delete(jobId);
    entry.resolve({ kind: "deny", message: "job cancelled" });
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run runner/__tests__/input-broker.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: コミット**

```bash
git add runner/input-broker.ts runner/__tests__/input-broker.test.ts
git commit -m "feat: input broker for pending permission/question hand-off

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: ワークフロー（worktree 準備 → エージェント実行 → PR 検証）

**Files:**
- Create: `runner/exec.ts`
- Create: `runner/executor.ts`
- Create: `runner/workflow.ts`
- Test: `runner/__tests__/workflow.test.ts`

**Interfaces:**
- Consumes: `JobStore` (Task 2), `InputBroker` (Task 3), 型 (Task 1)
- Produces:
  - `interface CommandRunner { run(cmd: string, args: string[], opts: { cwd: string }): Promise<{ stdout: string; stderr: string }> }` と `class RealCommandRunner`
  - `type ExecutorRunOpts = { cwd: string; prompt: string; resumeSessionId: string | null; signal: AbortSignal }`
  - `type ExecutorHooks = { onSessionId(id: string): void; onActivity(text: string): void; requestInput(input: PendingInput): Promise<PendingInputResponse> }`
  - `type ExecutorResult = { ok: true } | { ok: false; error: string }`
  - `interface AgentExecutor { run(opts: ExecutorRunOpts, hooks: ExecutorHooks): Promise<ExecutorResult> }`
  - `type WorkflowDeps = { store: JobStore; broker: InputBroker; commands: CommandRunner; executor: AgentExecutor; repoDir: string }`
  - `runIssueJob(deps: WorkflowDeps, jobId: string, signal: AbortSignal): Promise<void>`
  - `buildBranchName(issueNumber: number, title: string): string`

- [ ] **Step 1: 失敗するテストを書く**

`runner/__tests__/workflow.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PendingInput,
  PendingInputResponse,
} from "../../lib/jobs/types";
import { InputBroker } from "../input-broker";
import { JobStore } from "../store";
import type {
  AgentExecutor,
  CommandRunner,
  ExecutorHooks,
  ExecutorRunOpts,
} from "../executor";
import { buildBranchName, runIssueJob, type WorkflowDeps } from "../workflow";

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-"));
  store = new JobStore(dir);
  store.loadAll();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** コマンド呼び出しを記録し、シナリオに応じた stdout を返すフェイク */
class FakeCommands implements CommandRunner {
  calls: string[] = [];
  /** `gh pr list` が返す URL。null なら空配列を返す */
  prUrl: string | null = "https://github.com/yonda/cockpit/pull/9";

  async run(cmd: string, args: string[], _opts: { cwd: string }) {
    const line = [cmd, ...args].join(" ");
    this.calls.push(line);
    if (cmd === "gh" && args[0] === "issue") {
      return {
        stdout: JSON.stringify({ title: "test issue", body: "本文です" }),
        stderr: "",
      };
    }
    if (cmd === "gh" && args[0] === "pr") {
      return {
        stdout: JSON.stringify(this.prUrl ? [{ url: this.prUrl }] : []),
        stderr: "",
      };
    }
    if (cmd === "git" && args[0] === "worktree") {
      return {
        stdout: `worktree /tmp/cockpit-wt/feature/1-test-issue\nbranch refs/heads/feature/1-test-issue\n`,
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  }
}

/** 1 回許可を求めてから成功するフェイクエージェント */
class FakeExecutor implements AgentExecutor {
  result: { ok: true } | { ok: false; error: string } = { ok: true };
  askPermission = false;
  receivedResponse: PendingInputResponse | null = null;
  lastOpts: ExecutorRunOpts | null = null;

  async run(opts: ExecutorRunOpts, hooks: ExecutorHooks) {
    this.lastOpts = opts;
    hooks.onSessionId("sess-123");
    if (this.askPermission) {
      const input: PendingInput = {
        id: "in-1",
        kind: "permission",
        toolName: "Bash",
        input: { command: "curl example.com" },
        createdAt: new Date().toISOString(),
      };
      this.receivedResponse = await hooks.requestInput(input);
    }
    return this.result;
  }
}

function makeDeps(overrides: Partial<WorkflowDeps> = {}): WorkflowDeps & {
  commands: FakeCommands;
  executor: FakeExecutor;
} {
  return {
    store,
    broker: new InputBroker(),
    commands: new FakeCommands(),
    executor: new FakeExecutor(),
    repoDir: "/tmp/repo",
    ...overrides,
  } as WorkflowDeps & { commands: FakeCommands; executor: FakeExecutor };
}

describe("buildBranchName", () => {
  it("slugifies the title", () => {
    expect(buildBranchName(12, "Add launch pad!!")).toBe(
      "feature/12-add-launch-pad",
    );
  });
  it("falls back when the title has no ascii", () => {
    expect(buildBranchName(3, "日本語だけ")).toBe("feature/3-issue");
  });
});

describe("runIssueJob", () => {
  it("runs to done and records the PR url", async () => {
    const deps = makeDeps();
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const final = store.get(job.id)!;
    expect(final.status).toBe("done");
    expect(final.sessionId).toBe("sess-123");
    expect(final.prUrl).toBe("https://github.com/yonda/cockpit/pull/9");
    expect(final.worktreePath).toBe("/tmp/cockpit-wt/feature/1-test-issue");
    expect(deps.commands.calls).toContain("git fetch origin main");
    expect(deps.commands.calls).toContain("git wt feature/1-test-issue");
  });

  it("transitions to waiting_input and resumes on respond", async () => {
    const deps = makeDeps();
    deps.executor.askPermission = true;
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    const running = runIssueJob(deps, job.id, new AbortController().signal);

    // waiting_input になるまで待つ
    await new Promise<void>((resolve) => {
      store.on("job", (j) => {
        if (j.id === job.id && j.status === "waiting_input") resolve();
      });
    });
    expect(store.get(job.id)!.pendingInput?.toolName).toBe("Bash");

    deps.broker.resolve(job.id, store.get(job.id)!.pendingInput!.id, {
      kind: "allow",
    });
    await running;

    expect(deps.executor.receivedResponse).toEqual({ kind: "allow" });
    expect(store.get(job.id)!.status).toBe("done");
    expect(store.get(job.id)!.pendingInput).toBeNull();
  });

  it("fails when no PR exists after the agent finishes", async () => {
    const deps = makeDeps();
    deps.commands.prUrl = null;
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const final = store.get(job.id)!;
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/draft PR/);
  });

  it("fails when the executor reports an error", async () => {
    const deps = makeDeps();
    deps.executor.result = { ok: false, error: "boom" };
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);
    expect(store.get(job.id)!.status).toBe("failed");
    expect(store.get(job.id)!.error).toBe("boom");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run runner/__tests__/workflow.test.ts`
Expected: FAIL（`../executor` / `../workflow` が存在しない）

- [ ] **Step 3: `runner/exec.ts` を実装**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RunResult = { stdout: string; stderr: string };

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts: { cwd: string },
  ): Promise<RunResult>;
}

export class RealCommandRunner implements CommandRunner {
  async run(cmd: string, args: string[], opts: { cwd: string }) {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    return { stdout, stderr };
  }
}
```

- [ ] **Step 4: `runner/executor.ts` を実装（インターフェイスのみ）**

```ts
import type { PendingInput, PendingInputResponse } from "../lib/jobs/types";

export type { CommandRunner } from "./exec";

export type ExecutorRunOpts = {
  cwd: string;
  prompt: string;
  resumeSessionId: string | null;
  signal: AbortSignal;
};

export type ExecutorHooks = {
  onSessionId(sessionId: string): void;
  onActivity(text: string): void;
  requestInput(input: PendingInput): Promise<PendingInputResponse>;
};

export type ExecutorResult = { ok: true } | { ok: false; error: string };

/** Agent SDK を差し替え可能にする境界。テストはフェイク、実運用は SdkExecutor */
export interface AgentExecutor {
  run(opts: ExecutorRunOpts, hooks: ExecutorHooks): Promise<ExecutorResult>;
}
```

- [ ] **Step 5: `runner/workflow.ts` を実装**

```ts
import { randomUUID } from "node:crypto";
import type { PendingInput } from "../lib/jobs/types";
import type { AgentExecutor, CommandRunner } from "./executor";
import type { InputBroker } from "./input-broker";
import type { JobStore } from "./store";

export type WorkflowDeps = {
  store: JobStore;
  broker: InputBroker;
  commands: CommandRunner;
  executor: AgentExecutor;
  /** メインリポジトリの絶対パス (worktree 作成の起点) */
  repoDir: string;
};

export function buildBranchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return `feature/${issueNumber}-${slug || "issue"}`;
}

function buildPrompt(args: {
  issueNumber: number;
  title: string;
  body: string;
  branch: string;
}): string {
  return [
    `Issue #${args.issueNumber}: ${args.title} を実装してください。`,
    "",
    "## Issue 本文",
    args.body,
    "",
    "## 進め方",
    `- このディレクトリは Issue 専用の git worktree です (ブランチ: ${args.branch})`,
    "- 実装が終わったらテスト・lint を通し、変更をコミットして origin に push してください",
    `- 最後に \`gh pr create --draft\` で draft PR を作成してください (本文に "closes #${args.issueNumber}" を含める)`,
    "- draft PR の作成まで完了したら終了してください",
  ].join("\n");
}

/** git worktree list --porcelain の出力から branch -> path を引く */
function findWorktreePath(porcelain: string, branch: string): string | null {
  let currentPath: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && currentPath) return currentPath;
  }
  return null;
}

async function ensureWorktree(
  deps: WorkflowDeps,
  branch: string,
): Promise<string> {
  const list = async () => {
    const { stdout } = await deps.commands.run(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: deps.repoDir },
    );
    return findWorktreePath(stdout, branch);
  };

  const existing = await list();
  if (existing) return existing; // 再発射・リトライは既存 worktree を再利用

  // git wt は未存在なら origin ベースで作成する (グローバル運用規約のツール)
  await deps.commands.run("git", ["wt", branch], { cwd: deps.repoDir });
  const created = await list();
  if (!created) throw new Error(`worktree not found after git wt ${branch}`);
  return created;
}

export async function runIssueJob(
  deps: WorkflowDeps,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  const job = deps.store.get(jobId);
  if (!job) throw new Error(`unknown job: ${jobId}`);
  const isResume = job.sessionId !== null && job.worktreePath !== null;
  deps.store.transition(jobId, "running");

  try {
    // 1. worktree 準備
    let worktreePath = job.worktreePath;
    if (!isResume) {
      await deps.commands.run("git", ["fetch", "origin", "main"], {
        cwd: deps.repoDir,
      });
      worktreePath = await ensureWorktree(deps, job.branch);
      deps.store.update(jobId, { worktreePath });
    }

    // 2. プロンプト組み立て
    let prompt: string;
    if (isResume) {
      prompt =
        "runner プロセスの再起動から復帰しました。直前の作業状態 (git status とここまでの会話) を確認し、Issue の実装を続行してください。完了条件は変わらず draft PR の作成までです。";
    } else {
      const { stdout } = await deps.commands.run(
        "gh",
        ["issue", "view", String(job.issueNumber), "--json", "title,body"],
        { cwd: deps.repoDir },
      );
      const issue = JSON.parse(stdout) as { title: string; body: string };
      prompt = buildPrompt({
        issueNumber: job.issueNumber,
        title: issue.title,
        body: issue.body ?? "",
        branch: job.branch,
      });
    }

    // 3. エージェント実行
    const result = await deps.executor.run(
      {
        cwd: worktreePath!,
        prompt,
        resumeSessionId: isResume ? job.sessionId : null,
        signal,
      },
      {
        onSessionId: (sessionId) => deps.store.update(jobId, { sessionId }),
        onActivity: (text) => deps.store.update(jobId, { lastActivity: text }),
        requestInput: async (raw) => {
          const input: PendingInput = {
            ...raw,
            id: raw.id || `in-${randomUUID().slice(0, 8)}`,
            createdAt: new Date().toISOString(),
          };
          deps.store.transition(jobId, "waiting_input", {
            pendingInput: input,
          });
          const response = await deps.broker.request(jobId, input);
          // キャンセル済みなら running に戻さない
          if (deps.store.get(jobId)?.status === "waiting_input") {
            deps.store.transition(jobId, "running", { pendingInput: null });
          }
          return response;
        },
      },
    );

    if (signal.aborted) return; // cancel 側が状態遷移を行う

    if (!result.ok) {
      deps.store.transition(jobId, "failed", { error: result.error });
      return;
    }

    // 4. 成果検証: エージェントの自己申告を信用せず PR を確認する
    const { stdout } = await deps.commands.run(
      "gh",
      [
        "pr",
        "list",
        "--head",
        job.branch,
        "--state",
        "open",
        "--json",
        "url",
      ],
      { cwd: deps.repoDir },
    );
    const prs = JSON.parse(stdout) as Array<{ url: string }>;
    if (prs.length === 0) {
      deps.store.transition(jobId, "failed", {
        error: "エージェント終了後に draft PR が見つかりませんでした",
      });
      return;
    }
    deps.store.transition(jobId, "done", { prUrl: prs[0].url });
  } catch (err) {
    if (signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    const current = deps.store.get(jobId);
    if (current && ["running", "waiting_input"].includes(current.status)) {
      deps.store.transition(jobId, "failed", { error: message });
    }
  }
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `pnpm vitest run runner/__tests__/workflow.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 7: 全テスト + コミット**

Run: `pnpm test`
Expected: 全 PASS

```bash
git add runner/exec.ts runner/executor.ts runner/workflow.ts runner/__tests__/workflow.test.ts
git commit -m "feat: issue-to-PR workflow with injectable executor and command runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: スケジューラ（同時 2・キャンセル・起動時 resume）

**Files:**
- Create: `runner/scheduler.ts`
- Test: `runner/__tests__/scheduler.test.ts`

**Interfaces:**
- Consumes: `WorkflowDeps`, `runIssueJob` (Task 4), `JobStore` (Task 2), `InputBroker` (Task 3)
- Produces: `class Scheduler` —
  `constructor(deps: WorkflowDeps, opts?: { maxConcurrent?: number; runJob?: typeof runIssueJob })` /
  `poke(): void`（空きスロットに queued ジョブを投入）/
  `cancel(jobId: string): void` / `resumeOnBoot(): void`

- [ ] **Step 1: 失敗するテストを書く**

`runner/__tests__/scheduler.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputBroker } from "../input-broker";
import { Scheduler } from "../scheduler";
import { JobStore } from "../store";
import type { WorkflowDeps } from "../workflow";

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-"));
  store = new JobStore(dir);
  store.loadAll();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fields = (n: number) => ({
  repo: "yonda/cockpit",
  issueNumber: n,
  issueTitle: `issue ${n}`,
  branch: `feature/${n}-issue-${n}`,
});

function makeDeps(): WorkflowDeps {
  return {
    store,
    broker: new InputBroker(),
    commands: { run: async () => ({ stdout: "", stderr: "" }) },
    executor: { run: async () => ({ ok: true as const }) },
    repoDir: "/tmp/repo",
  };
}

describe("Scheduler", () => {
  it("runs at most maxConcurrent jobs at once", async () => {
    const resolvers: Array<() => void> = [];
    // runJob を差し替えて完了タイミングを制御する
    const runJob = vi.fn(
      (_deps: WorkflowDeps, _jobId: string, _signal: AbortSignal) =>
        new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    const scheduler = new Scheduler(makeDeps(), {
      maxConcurrent: 2,
      runJob,
    });

    store.create(fields(1));
    store.create(fields(2));
    store.create(fields(3));
    scheduler.poke();

    expect(runJob).toHaveBeenCalledTimes(2);

    resolvers[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(runJob).toHaveBeenCalledTimes(3);
  });

  it("cancel aborts the signal and marks the job cancelled", async () => {
    let captured: AbortSignal | null = null;
    const runJob = vi.fn(
      (_deps: WorkflowDeps, _jobId: string, signal: AbortSignal) => {
        captured = signal;
        return new Promise<void>(() => {}); // 完了しない
      },
    );
    const scheduler = new Scheduler(makeDeps(), { maxConcurrent: 2, runJob });
    const job = store.create(fields(1));
    scheduler.poke();

    scheduler.cancel(job.id);
    expect(captured!.aborted).toBe(true);
    expect(store.get(job.id)!.status).toBe("cancelled");
  });

  it("resumeOnBoot requeues interrupted jobs with a session and fails those without", () => {
    const j1 = store.create(fields(1));
    store.transition(j1.id, "running", {
      sessionId: "sess-1",
      worktreePath: "/tmp/cockpit-wt/feature/1-issue-1",
    });
    const j2 = store.create(fields(2));
    store.transition(j2.id, "running"); // sessionId なし

    // 再起動をシミュレート
    const reloaded = new JobStore(dir);
    reloaded.loadAll();
    const runJob = vi.fn(() => new Promise<void>(() => {}));
    const scheduler = new Scheduler(
      { ...makeDeps(), store: reloaded },
      { maxConcurrent: 2, runJob },
    );
    scheduler.resumeOnBoot();

    expect(reloaded.get(j1.id)!.status).toBe("running");
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(reloaded.get(j2.id)!.status).toBe("failed");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run runner/__tests__/scheduler.test.ts`
Expected: FAIL（`../scheduler` が存在しない）

- [ ] **Step 3: `runner/scheduler.ts` を実装**

```ts
import { runIssueJob, type WorkflowDeps } from "./workflow";

export class Scheduler {
  private active = new Map<string, AbortController>();
  private readonly maxConcurrent: number;
  private readonly runJob: typeof runIssueJob;

  constructor(
    private readonly deps: WorkflowDeps,
    opts: { maxConcurrent?: number; runJob?: typeof runIssueJob } = {},
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.runJob = opts.runJob ?? runIssueJob;
  }

  /** 空きスロットがあれば古い順に queued ジョブを開始する */
  poke(): void {
    if (this.active.size >= this.maxConcurrent) return;
    const queued = this.deps.store
      .list()
      .filter((j) => j.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of queued) {
      if (this.active.size >= this.maxConcurrent) break;
      this.start(job.id);
    }
  }

  private start(jobId: string): void {
    const controller = new AbortController();
    this.active.set(jobId, controller);
    void this.runJob(this.deps, jobId, controller.signal)
      .catch(() => {
        // runIssueJob 内で failed 遷移済み。ここは取りこぼし防止のみ
      })
      .finally(() => {
        this.active.delete(jobId);
        this.poke();
      });
  }

  cancel(jobId: string): void {
    const controller = this.active.get(jobId);
    if (controller) controller.abort();
    this.deps.broker.abort(jobId);
    const job = this.deps.store.get(jobId);
    if (job && ["queued", "running", "waiting_input"].includes(job.status)) {
      this.deps.store.transition(jobId, "cancelled", { pendingInput: null });
    }
  }

  /**
   * 起動時復旧: 前回プロセスが落ちたときに running / waiting_input で
   * 残っているジョブを、session があれば resume 再実行、なければ failed にする。
   */
  resumeOnBoot(): void {
    for (const job of this.deps.store.list()) {
      if (!["running", "waiting_input"].includes(job.status)) continue;
      if (job.sessionId && job.worktreePath) {
        // runIssueJob は running 遷移から始まるので一度 queued 相当に見せる
        // (waiting_input -> running は合法遷移なのでそのまま start してよい)
        this.deps.store.update(job.id, { pendingInput: null });
        this.start(job.id);
      } else {
        this.deps.store.transition(job.id, "failed", {
          error: "runner 再起動時に復旧できませんでした (session なし)",
          pendingInput: null,
        });
      }
    }
    this.poke();
  }
}
```

注意: `runIssueJob` 冒頭の `transition(jobId, "running")` は `waiting_input -> running`・`running -> running` を通さない。`running -> running` は不正遷移なので、Step 4 で `runIssueJob` の冒頭を「既に running ならそのまま」へ修正する。

- [ ] **Step 4: `runner/workflow.ts` の遷移を resume 対応に修正**

`runIssueJob` の `deps.store.transition(jobId, "running");` を以下に置き換え:

```ts
  if (job.status === "waiting_input") {
    deps.store.transition(jobId, "running", { pendingInput: null });
  } else if (job.status !== "running") {
    deps.store.transition(jobId, "running");
  }
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm test`
Expected: 全 PASS（types / store / input-broker / workflow / scheduler）

- [ ] **Step 6: コミット**

```bash
git add runner/scheduler.ts runner/__tests__/scheduler.test.ts runner/workflow.ts
git commit -m "feat: job scheduler with concurrency cap, cancel, and boot resume

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: ソケットサーバー + Next 側クライアント

**Files:**
- Create: `runner/server.ts`
- Create: `lib/runner/client.ts`
- Test: `runner/__tests__/server.test.ts`

**Interfaces:**
- Consumes: `JobStore`, `Scheduler`, `InputBroker`, `buildBranchName`, プロトコル型 (Task 1)
- Produces:
  - `startRunnerServer(socketPath: string, deps: { store: JobStore; scheduler: Scheduler; broker: InputBroker }): import("node:net").Server`
  - `callRunner<T>(method: RunnerRequest["method"], params: unknown): Promise<T>`（Next 側、5 秒タイムアウト）
  - `openRunnerEventStream(opts: { signal: AbortSignal; onEvent: (e: RunnerEvent) => void; onError: (msg: string) => void }): void`（1 秒間隔で自動再接続）

- [ ] **Step 1: 失敗するテストを書く**

`runner/__tests__/server.test.ts`（テストは Next 側クライアント `callRunner` を実ソケット越しに使い、プロトコル両端を同時に検証する）:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, RunnerEvent } from "../../lib/jobs/types";
import { InputBroker } from "../input-broker";
import { Scheduler } from "../scheduler";
import { startRunnerServer } from "../server";
import { JobStore } from "../store";

let dir: string;
let socketPath: string;
let store: JobStore;
let server: Server;
let scheduler: Scheduler;
let broker: InputBroker;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "srv-"));
  socketPath = join(dir, "runner.sock");
  process.env.RUNNER_SOCKET_PATH = socketPath;
  store = new JobStore(join(dir, "jobs"));
  store.loadAll();
  broker = new InputBroker();
  scheduler = new Scheduler(
    {
      store,
      broker,
      commands: { run: async () => ({ stdout: "", stderr: "" }) },
      executor: { run: async () => ({ ok: true as const }) },
      repoDir: dir,
    },
    { runJob: () => new Promise<void>(() => {}) }, // ジョブは進めない
  );
  server = startRunnerServer(socketPath, { store, scheduler, broker });
});

afterEach(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RUNNER_SOCKET_PATH;
  vi.resetModules(); // client が SOCKET_PATH を再評価できるように
});

// lib/runner/client は module 評価時に env を読むため動的 import する
async function client() {
  return await import("../../lib/runner/client");
}

describe("runner socket protocol", () => {
  it("job.fire creates a queued job and job.list returns it", async () => {
    const { callRunner } = await client();
    const fired = await callRunner<{ job: Job }>("job.fire", {
      repo: "yonda/cockpit",
      issueNumber: 5,
      issueTitle: "Add launch pad",
    });
    expect(fired.job.branch).toBe("feature/5-add-launch-pad");

    const { jobs } = await callRunner<{ jobs: Job[] }>("job.list", {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(fired.job.id);
  });

  it("rejects a duplicate fire for the same issue", async () => {
    const { callRunner } = await client();
    await callRunner("job.fire", {
      repo: "yonda/cockpit",
      issueNumber: 5,
      issueTitle: "Add launch pad",
    });
    await expect(
      callRunner("job.fire", {
        repo: "yonda/cockpit",
        issueNumber: 5,
        issueTitle: "Add launch pad",
      }),
    ).rejects.toThrow(/already active/);
  });

  it("streams job.updated events to subscribers", async () => {
    const { callRunner, openRunnerEventStream } = await client();
    const events: RunnerEvent[] = [];
    const ac = new AbortController();
    openRunnerEventStream({
      signal: ac.signal,
      onEvent: (e) => events.push(e),
      onError: () => {},
    });
    await new Promise((r) => setTimeout(r, 50)); // subscribe 完了待ち

    await callRunner("job.fire", {
      repo: "yonda/cockpit",
      issueNumber: 7,
      issueTitle: "stream test",
    });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    expect(events.some((e) => e.event === "job.updated")).toBe(true);
  });

  it("job.respond resolves the broker", async () => {
    const { callRunner } = await client();
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 9,
      issueTitle: "respond test",
      branch: "feature/9-respond-test",
    });
    store.transition(job.id, "running");
    const input = {
      id: "in-1",
      kind: "permission" as const,
      toolName: "Bash",
      input: { command: "true" },
      createdAt: new Date().toISOString(),
    };
    store.transition(job.id, "waiting_input", { pendingInput: input });
    const pending = broker.request(job.id, input);

    await callRunner("job.respond", {
      jobId: job.id,
      inputId: "in-1",
      response: { kind: "allow" },
    });
    await expect(pending).resolves.toEqual({ kind: "allow" });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run runner/__tests__/server.test.ts`
Expected: FAIL（`../server` / `client` が存在しない）

- [ ] **Step 3: `runner/server.ts` を実装**

```ts
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type {
  Job,
  PendingInputResponse,
  RunnerRequest,
  RunnerResponse,
} from "../lib/jobs/types";
import type { InputBroker } from "./input-broker";
import type { Scheduler } from "./scheduler";
import type { JobStore } from "./store";
import { buildBranchName } from "./workflow";

type Deps = { store: JobStore; scheduler: Scheduler; broker: InputBroker };

const ACTIVE = new Set(["queued", "running", "waiting_input"]);

export function startRunnerServer(socketPath: string, deps: Deps): Server {
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) unlinkSync(socketPath); // 前回の残骸

  const subscribers = new Set<Socket>();
  deps.store.on("job", (job: Job) => {
    const line = `${JSON.stringify({ event: "job.updated", data: job })}\n`;
    for (const socket of subscribers) socket.write(line);
  });

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        handleLine(line, socket, subscribers, deps);
      }
    });
    const drop = () => subscribers.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  server.listen(socketPath);
  return server;
}

function respond(socket: Socket, response: RunnerResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function handleLine(
  line: string,
  socket: Socket,
  subscribers: Set<Socket>,
  deps: Deps,
): void {
  let request: RunnerRequest;
  try {
    request = JSON.parse(line) as RunnerRequest;
  } catch {
    respond(socket, { id: "?", error: { message: "invalid json" } });
    return;
  }

  try {
    switch (request.method) {
      case "job.list":
        respond(socket, { id: request.id, result: { jobs: deps.store.list() } });
        return;

      case "job.fire": {
        const { repo, issueNumber, issueTitle } = request.params;
        const duplicate = deps.store
          .list()
          .find(
            (j) =>
              j.repo === repo &&
              j.issueNumber === issueNumber &&
              ACTIVE.has(j.status),
          );
        if (duplicate) {
          respond(socket, {
            id: request.id,
            error: { message: `issue #${issueNumber} is already active (${duplicate.id})` },
          });
          return;
        }
        const job = deps.store.create({
          repo,
          issueNumber,
          issueTitle,
          branch: buildBranchName(issueNumber, issueTitle),
        });
        deps.scheduler.poke();
        respond(socket, { id: request.id, result: { job } });
        return;
      }

      case "job.cancel":
        deps.scheduler.cancel(request.params.jobId);
        respond(socket, { id: request.id, result: {} });
        return;

      case "job.respond": {
        const { jobId, inputId, response } = request.params as {
          jobId: string;
          inputId: string;
          response: PendingInputResponse;
        };
        const ok = deps.broker.resolve(jobId, inputId, response);
        if (!ok) {
          respond(socket, {
            id: request.id,
            error: { message: "no matching pending input" },
          });
          return;
        }
        respond(socket, { id: request.id, result: {} });
        return;
      }

      case "events.subscribe":
        subscribers.add(socket);
        respond(socket, { id: request.id, result: { subscribed: true } });
        return;

      default:
        respond(socket, {
          id: (request as { id?: string }).id ?? "?",
          error: { message: "unknown method" },
        });
    }
  } catch (err) {
    respond(socket, {
      id: request.id,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }
}
```

- [ ] **Step 4: `lib/runner/client.ts` を実装**

`lib/herdr/server.ts` の `callHerdr` と同じ構造。socket path だけ違う:

```ts
import { createConnection, type Socket } from "node:net";
import {
  RUNNER_SOCKET_PATH,
  type RunnerEvent,
  type RunnerRequest,
  type RunnerResponse,
} from "@/lib/jobs/types";

const REQUEST_TIMEOUT_MS = 5_000;
const RECONNECT_DELAY_MS = 1_000;

export async function callRunner<T>(
  method: RunnerRequest["method"],
  params: unknown,
): Promise<T> {
  const request = {
    id: `req-${Math.random().toString(36).slice(2, 10)}`,
    method,
    params,
  };
  const response = await new Promise<RunnerResponse>((resolve, reject) => {
    const socket = createConnection(RUNNER_SOCKET_PATH);
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      settle(() => {
        socket.destroy();
        reject(new Error(`runner socket timeout after ${REQUEST_TIMEOUT_MS}ms`));
      });
    }, REQUEST_TIMEOUT_MS);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as RunnerResponse;
          if (parsed.id === request.id) {
            settle(() => {
              socket.end();
              resolve(parsed);
            });
            return;
          }
        } catch {
          // skip malformed line
        }
      }
    });
    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("close", () =>
      settle(() => reject(new Error("runner socket closed before responding"))),
    );
  });

  if (response.error) throw new Error(response.error.message);
  return response.result as T;
}

export function openRunnerEventStream({
  signal,
  onEvent,
  onError,
}: {
  signal: AbortSignal;
  onEvent: (event: RunnerEvent) => void;
  onError: (message: string) => void;
}): void {
  let socket: Socket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const closeSocket = () => {
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
  };

  const cleanup = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    closeSocket();
  };
  signal.addEventListener("abort", cleanup, { once: true });

  const scheduleReconnect = (reason: string) => {
    if (signal.aborted || reconnectTimer) return;
    onError(reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  };

  function connect(): void {
    if (signal.aborted) return;
    closeSocket();
    const sock = createConnection(RUNNER_SOCKET_PATH);
    socket = sock;
    let buffer = "";

    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({ id: "sub", method: "events.subscribe", params: {} })}\n`,
      );
    });
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: { id?: string; event?: string; data?: unknown };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id === "sub") continue; // subscription ack
        if (parsed.event === "job.updated") {
          onEvent(parsed as RunnerEvent);
        }
      }
    });
    sock.on("error", (err) => {
      if (socket === sock) scheduleReconnect(err.message);
    });
    sock.on("close", () => {
      if (socket === sock && !signal.aborted) {
        scheduleReconnect("runner socket closed");
      }
    });
  }

  connect();
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm test`
Expected: 全 PASS

注意: `lib/runner/client.ts` は `@/lib/jobs/types` alias を使う。vitest が alias を解決できない場合は `vitest.config.ts` に追加:

```ts
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["runner/__tests__/**/*.test.ts"],
  },
});
```

- [ ] **Step 6: コミット**

```bash
git add runner/server.ts lib/runner/client.ts runner/__tests__/server.test.ts vitest.config.ts
git commit -m "feat: runner socket server and Next-side client over JSON lines

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: SDK executor（Agent SDK 実装）

**Files:**
- Create: `runner/sdk-executor.ts`
- Test: `runner/__tests__/sdk-executor.test.ts`（変換ロジックのみ）
- Modify: `package.json`（dependencies）

**Interfaces:**
- Consumes: `AgentExecutor`, `ExecutorRunOpts`, `ExecutorHooks` (Task 4)
- Produces: `class SdkExecutor implements AgentExecutor`、`toPermissionResult(response: PendingInputResponse, originalInput: Record<string, unknown>): PermissionResult`

> **注意**: このタスクのコードは実装時に `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（型定義）と公式ドキュメント https://code.claude.com/docs/en/agent-sdk/typescript を必ず突き合わせること。以下は設計時点の調査に基づくが、SDK は更新が速い。

- [ ] **Step 1: SDK を導入**

```bash
pnpm add @anthropic-ai/claude-agent-sdk
```

- [ ] **Step 2: 変換ロジックの失敗するテストを書く**

`runner/__tests__/sdk-executor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toPermissionResult } from "../sdk-executor";

describe("toPermissionResult", () => {
  it("maps allow", () => {
    expect(toPermissionResult({ kind: "allow" }, { command: "true" })).toEqual({
      behavior: "allow",
      updatedInput: { command: "true" },
    });
  });

  it("maps deny with message", () => {
    expect(
      toPermissionResult({ kind: "deny", message: "使わないで" }, {}),
    ).toEqual({ behavior: "deny", message: "使わないで" });
  });

  it("maps question answers into updatedInput", () => {
    const original = {
      questions: [{ question: "どっち?", header: "選択", options: [], multiSelect: false }],
    };
    const result = toPermissionResult(
      { kind: "answers", answers: [["案A"]] },
      original,
    );
    expect(result.behavior).toBe("allow");
    // answers は SDK の期待する形で updatedInput に埋め込まれる
    // (実装時に sdk.d.ts の AskUserQuestion 応答形式と一致させること)
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm vitest run runner/__tests__/sdk-executor.test.ts`
Expected: FAIL（`../sdk-executor` が存在しない）

- [ ] **Step 4: `runner/sdk-executor.ts` を実装**

```ts
import {
  query,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PendingInputResponse } from "../lib/jobs/types";
import type {
  AgentExecutor,
  ExecutorHooks,
  ExecutorResult,
  ExecutorRunOpts,
} from "./executor";

// 定型ワークフローに必要なツールは事前許可。ここに無い Bash・外部送信系と
// AskUserQuestion が canUseTool に落ちて cockpit へ転送される。
const ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "TodoWrite",
  "Task",
  "Bash(git:*)",
  "Bash(gh issue view:*)",
  "Bash(gh pr create:*)",
  "Bash(gh pr list:*)",
  "Bash(pnpm install:*)",
  "Bash(pnpm test:*)",
  "Bash(pnpm lint:*)",
  "Bash(pnpm build:*)",
  "Bash(pnpm vitest:*)",
];

export function toPermissionResult(
  response: PendingInputResponse,
  originalInput: Record<string, unknown>,
): PermissionResult {
  if (response.kind === "deny") {
    return { behavior: "deny", message: response.message };
  }
  if (response.kind === "answers") {
    // AskUserQuestion: 選択された回答を input に反映して allow する。
    // 実装時に sdk.d.ts / 公式 user-input ドキュメントの形式と一致させること。
    const questions = (originalInput.questions ?? []) as Array<{
      question: string;
    }>;
    return {
      behavior: "allow",
      updatedInput: {
        ...originalInput,
        answers: questions.map((q, i) => ({
          question: q.question,
          selected: response.answers[i] ?? [],
        })),
      },
    };
  }
  return { behavior: "allow", updatedInput: originalInput };
}

function extractAssistantText(message: SDKMessage): string | null {
  if (message.type !== "assistant") return null;
  const content = message.message.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text.slice(0, 200);
    }
    if (block.type === "tool_use") {
      return `tool: ${block.name}`;
    }
  }
  return null;
}

export class SdkExecutor implements AgentExecutor {
  async run(
    opts: ExecutorRunOpts,
    hooks: ExecutorHooks,
  ): Promise<ExecutorResult> {
    try {
      const stream = query({
        prompt: opts.prompt,
        options: {
          cwd: opts.cwd,
          permissionMode: "acceptEdits",
          allowedTools: ALLOWED_TOOLS,
          resume: opts.resumeSessionId ?? undefined,
          abortController: signalToController(opts.signal),
          canUseTool: async (toolName, input) => {
            const response = await hooks.requestInput({
              id: "", // workflow 側で採番される
              kind: toolName === "AskUserQuestion" ? "question" : "permission",
              toolName,
              input,
              createdAt: "",
            });
            return toPermissionResult(
              response,
              input as Record<string, unknown>,
            );
          },
        },
      });

      for await (const message of stream) {
        if (message.type === "system" && message.subtype === "init") {
          hooks.onSessionId(message.session_id);
        }
        const activity = extractAssistantText(message);
        if (activity) hooks.onActivity(activity);
        if (message.type === "result") {
          return message.subtype === "success"
            ? { ok: true }
            : { ok: false, error: `agent finished with ${message.subtype}` };
        }
      }
      return { ok: false, error: "stream ended without result message" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function signalToController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
```

- [ ] **Step 5: 実装を sdk.d.ts と突き合わせて修正**

Run: `cat node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts | head -400`（`query` / `Options` / `PermissionResult` / `SDKMessage` の実際の形を確認）

特に確認する点:
- `canUseTool` のシグネチャと `PermissionResult` のフィールド名
- AskUserQuestion への応答形式（公式 user-input ドキュメントのサンプル通りに `toPermissionResult` の answers 部分を修正）
- `resume` オプション名と `abortController` の渡し方
- `system/init` メッセージの `session_id` フィールド名

- [ ] **Step 6: テスト + 型チェック**

Run: `pnpm vitest run runner/__tests__/sdk-executor.test.ts && pnpm exec tsc --noEmit`
Expected: PASS / 型エラーなし

- [ ] **Step 7: コミット**

```bash
git add runner/sdk-executor.ts runner/__tests__/sdk-executor.test.ts package.json pnpm-lock.yaml
git commit -m "feat: Agent SDK executor with permission forwarding via canUseTool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: runner main + esbuild + launchd サービス

**Files:**
- Create: `runner/main.ts`
- Create: `services/cockpit-runner.plist.template`
- Modify: `package.json`（scripts.build:runner / devDependencies に esbuild）
- Modify: `bin/service`（runner-install / runner-uninstall / runner-restart / runner-status / runner-logs）

**Interfaces:**
- Consumes: Task 1〜7 の全モジュール
- Produces: `dist/runner.cjs`（バンドル済み実行ファイル）、launchd ラベル `com.cockpit.runner`

- [ ] **Step 1: `runner/main.ts` を実装**

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { JOBS_DIR, RUNNER_SOCKET_PATH } from "../lib/jobs/types";
import { RealCommandRunner } from "./exec";
import { InputBroker } from "./input-broker";
import { Scheduler } from "./scheduler";
import { SdkExecutor } from "./sdk-executor";
import { startRunnerServer } from "./server";
import { JobStore } from "./store";

// メインリポジトリの場所。launchd の WorkingDirectory がリポジトリルート。
const REPO_DIR = process.env.COCKPIT_REPO_DIR ?? process.cwd();

function main(): void {
  const store = new JobStore(JOBS_DIR);
  store.loadAll();
  const broker = new InputBroker();
  const scheduler = new Scheduler({
    store,
    broker,
    commands: new RealCommandRunner(),
    executor: new SdkExecutor(),
    repoDir: REPO_DIR,
  });

  startRunnerServer(RUNNER_SOCKET_PATH, { store, scheduler, broker });
  scheduler.resumeOnBoot();

  console.log(
    `[runner] listening on ${RUNNER_SOCKET_PATH} (repo: ${REPO_DIR}, jobs: ${JOBS_DIR})`,
  );
}

main();
```

- [ ] **Step 2: esbuild を導入してビルドスクリプトを追加**

```bash
pnpm add -D esbuild
```

`package.json` scripts に追加:

```json
"build:runner": "esbuild runner/main.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/runner.cjs --external:@anthropic-ai/claude-agent-sdk"
```

SDK は同梱 CLI バイナリを spawn するため node_modules レイアウトに依存する。**必ず `--external` にして、実行時はプロジェクトルート（node_modules が見える場所）を WorkingDirectory にする。**

`.gitignore` に追加:

```
# runner build output
/dist
```

Run: `pnpm build:runner && node -e "console.log(require('node:fs').existsSync('dist/runner.cjs'))"`
Expected: `true`

- [ ] **Step 3: `services/cockpit-runner.plist.template` を作成**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>__LABEL__</string>

  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__PROJECT_DIR__/dist/runner.cjs</string>
  </array>

  <key>WorkingDirectory</key>
  <string>__PROJECT_DIR__</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>__HOME__</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:__HOME__/.local/share/mise/shims:__HOME__/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>__HOME__/Library/Logs/cockpit-runner.out.log</string>

  <key>StandardErrorPath</key>
  <string>__HOME__/Library/Logs/cockpit-runner.err.log</string>
</dict>
</plist>
```

`__NODE__` は `bin/service` の render 時に `command -v node` で解決して置換する（Step 4 参照）。launchd は PATH 解決前にバイナリを起動するため、絶対パスが必要。

- [ ] **Step 4: `bin/service` に runner コマンドを追加**

既存の `CAL_LABEL` ブロックの下に定義を追加:

```bash
RUNNER_LABEL="com.cockpit.runner"
RUNNER_PLIST_TEMPLATE="services/cockpit-runner.plist.template"
RUNNER_PLIST_DEST="$HOME/Library/LaunchAgents/${RUNNER_LABEL}.plist"
```

`render_plist()` に `__NODE__` の置換を追加:

```bash
render_plist() {
  local template="$1" label="$2"
  sed \
    -e "s|__LABEL__|${label}|g" \
    -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__NODE__|$(command -v node)|g" \
    "${template}"
}
```

case 文に追加（`calendar-status)` の後）:

```bash
  runner-install)     [[ -f dist/runner.cjs ]] || { echo "先に pnpm build:runner を実行してください" >&2; exit 1; }
                      install_agent "${RUNNER_PLIST_TEMPLATE}" "${RUNNER_LABEL}" "${RUNNER_PLIST_DEST}"
                      echo "runner を launchd に登録しました" ;;
  runner-uninstall)   uninstall_agent "${RUNNER_LABEL}" "${RUNNER_PLIST_DEST}" ;;
  runner-restart)     launchctl kickstart -k "${DOMAIN_TARGET}/${RUNNER_LABEL}"
                      echo "runner restarted" ;;
  runner-status)      status_agent "${RUNNER_LABEL}"
                      echo "--- health ---"
                      command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && echo "gh: ok" || echo "gh: NG (gh auth login)"
                      git wt >/dev/null 2>&1 && echo "git wt: ok" || echo "git wt: NG (brew install k1LoW/tap/git-wt)"
                      [[ -S "$HOME/.cache/cockpit/runner.sock" ]] && echo "socket: ok" || echo "socket: not listening" ;;
  runner-logs)        tail -f "$HOME/Library/Logs/cockpit-runner.out.log" "$HOME/Library/Logs/cockpit-runner.err.log" ;;
```

usage の Commands にも同じ 5 コマンドを 1 行ずつ追記する。

- [ ] **Step 5: 動作確認**

```bash
pnpm build:runner
bin/service runner-install
bin/service runner-status
```

Expected: `state = running`、`gh: ok`、`git wt: ok`、`socket: ok`

- [ ] **Step 6: コミット**

```bash
git add runner/main.ts services/cockpit-runner.plist.template bin/service package.json pnpm-lock.yaml .gitignore
git commit -m "feat: runner daemon entrypoint, esbuild bundle, and launchd service

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Next API（プロキシ）+ Issue フェッチャ

**Files:**
- Create: `lib/github/issues.ts`
- Create: `app/api/jobs/route.ts`
- Create: `app/api/jobs/fire/route.ts`
- Create: `app/api/jobs/[id]/respond/route.ts`
- Create: `app/api/jobs/[id]/cancel/route.ts`
- Create: `app/api/jobs/events/route.ts`

**Interfaces:**
- Consumes: `callRunner` / `openRunnerEventStream` (Task 6), `graphql` (`lib/github/client.ts`), 型 (Task 1)
- Produces:
  - `fetchOpenIssues(): Promise<LaunchIssue[]>` — `type LaunchIssue = { number: number; title: string; url: string; createdAt: string; labels: Array<{ name: string; color: string }> }`
  - HTTP: `GET /api/jobs` → `{ ok: true, jobs: Job[] }` / `POST /api/jobs/fire` `{ issueNumber, issueTitle }` / `POST /api/jobs/:id/respond` `{ inputId, response }` / `POST /api/jobs/:id/cancel` / `GET /api/jobs/events` (SSE, event: `change`)

> **開始前に必ず** `node_modules/next/dist/docs/` の Route Handlers と dynamic route params のドキュメントを読むこと（Next 16 では `params` が Promise）。

- [ ] **Step 1: `lib/github/issues.ts` を実装**

```ts
import { graphql } from "@/lib/github/client";
import { LAUNCH_REPO } from "@/lib/jobs/types";

export type LaunchIssue = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: Array<{ name: string; color: string }>;
};

type IssuesQuery = {
  repository: {
    issues: {
      nodes: Array<{
        number: number;
        title: string;
        url: string;
        createdAt: string;
        labels: { nodes: Array<{ name: string; color: string }> };
      }>;
    };
  } | null;
};

const QUERY = /* GraphQL */ `
  query LaunchIssues($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      issues(
        states: OPEN
        first: 50
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        nodes {
          number
          title
          url
          createdAt
          labels(first: 10) {
            nodes { name color }
          }
        }
      }
    }
  }
`;

export async function fetchOpenIssues(): Promise<LaunchIssue[]> {
  const [owner, name] = LAUNCH_REPO.split("/");
  const data = await graphql<IssuesQuery>(QUERY, {
    variables: { owner, name },
    tags: ["launch-issues"],
  });
  return (data.repository?.issues.nodes ?? []).map((n) => ({
    number: n.number,
    title: n.title,
    url: n.url,
    createdAt: n.createdAt,
    labels: n.labels.nodes,
  }));
}
```

- [ ] **Step 2: ジョブ API ルートを実装**

`app/api/jobs/route.ts`:

```ts
import { NextResponse } from "next/server";
import type { Job } from "@/lib/jobs/types";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { jobs } = await callRunner<{ jobs: Job[] }>("job.list", {});
    return NextResponse.json({ ok: true, jobs });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to reach runner socket";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
```

`app/api/jobs/fire/route.ts`:

```ts
import { NextResponse } from "next/server";
import { LAUNCH_REPO, type Job } from "@/lib/jobs/types";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { issueNumber?: unknown; issueTitle?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (typeof body.issueNumber !== "number" || typeof body.issueTitle !== "string") {
    return NextResponse.json(
      { ok: false, error: "issueNumber (number) and issueTitle (string) are required" },
      { status: 400 },
    );
  }
  try {
    const { job } = await callRunner<{ job: Job }>("job.fire", {
      repo: LAUNCH_REPO,
      issueNumber: body.issueNumber,
      issueTitle: body.issueTitle,
    });
    console.log(`[launch] fired issue #${body.issueNumber} -> ${job.id}`);
    return NextResponse.json({ ok: true, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : "fire failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
```

`app/api/jobs/[id]/respond/route.ts`:

```ts
import { NextResponse } from "next/server";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { inputId?: unknown; response?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (typeof body.inputId !== "string" || typeof body.response !== "object") {
    return NextResponse.json(
      { ok: false, error: "inputId and response are required" },
      { status: 400 },
    );
  }
  try {
    await callRunner("job.respond", {
      jobId: id,
      inputId: body.inputId,
      response: body.response,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "respond failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
```

`app/api/jobs/[id]/cancel/route.ts`:

```ts
import { NextResponse } from "next/server";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await callRunner("job.cancel", { jobId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "cancel failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
```

`app/api/jobs/events/route.ts`（`app/api/panes/events/route.ts` と同構造）:

```ts
import { openRunnerEventStream } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      const heartbeat = setInterval(() => {
        send(`: heartbeat\n\n`);
      }, HEARTBEAT_INTERVAL_MS);

      request.signal.addEventListener(
        "abort",
        () => {
          closed = true;
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
        { once: true },
      );

      openRunnerEventStream({
        signal: request.signal,
        onEvent: (event) => {
          send(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
        },
        onError: (message) => {
          send(`event: upstream-error\ndata: ${JSON.stringify({ message })}\n\n`);
        },
      });

      send(`: connected\n\n`);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 3: 型チェック + 手動確認**

```bash
pnpm exec tsc --noEmit
bin/dev
```

別ターミナル（または `curl` で）:

```bash
curl -s localhost:3000/api/jobs | head -c 200
```

Expected: `{"ok":true,"jobs":[...]}`（runner 稼働中の場合）または `{"ok":false,...}` 502（停止中）。どちらも JSON で返ればプロキシは正常。

- [ ] **Step 4: コミット**

```bash
git add lib/github/issues.ts app/api/jobs
git commit -m "feat: jobs API proxy routes and launch issue fetcher

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: UI（/launch ページ）

**Files:**
- Create: `app/_components/useJobsState.tsx`
- Create: `app/_components/JobCard.tsx`
- Create: `app/_components/LaunchBoard.tsx`
- Create: `app/_components/JobNotifyWatcher.tsx`
- Create: `app/launch/page.tsx`
- Modify: `app/_components/NavTabs.tsx:6-11`（NAV 配列に 1 行追加）
- Modify: `app/layout.tsx`（JobNotifyWatcher をマウント）

**Interfaces:**
- Consumes: `Job`, `PendingInput`, `PendingInputResponse` (Task 1), `LaunchIssue` / `fetchOpenIssues` (Task 9), HTTP API (Task 9)
- Produces: `/launch` ページ。デザインは既存コンポーネント（PaneCard の statusConfig、Section, EmptyState, ErrorState, SectionBoundary）の語彙に合わせる

- [ ] **Step 1: `app/_components/useJobsState.tsx` を実装**

`useHerdrState.tsx` と同じ構造（fetch + SSE + debounce）。fetch 先とイベント名だけ違う:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { Job } from "@/lib/jobs/types";

const REFETCH_DEBOUNCE_MS = 300;

export type JobsLoadResult =
  | { status: "loading" }
  | { status: "ok"; jobs: Job[] }
  | { status: "error"; message: string };

export function useJobsState(): { result: JobsLoadResult; live: boolean } {
  const [result, setResult] = useState<JobsLoadResult>({ status: "loading" });
  const [live, setLive] = useState(false);
  const hasDataRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const refetch = async () => {
      try {
        const res = await fetch("/api/jobs", { cache: "no-store" });
        const body = (await res.json()) as
          | { ok: true; jobs: Job[] }
          | { ok: false; error: string };
        if (cancelled) return;
        if (!body.ok) {
          if (!hasDataRef.current) {
            setResult({ status: "error", message: body.error });
          }
          return;
        }
        hasDataRef.current = true;
        setResult({ status: "ok", jobs: body.jobs });
      } catch (err) {
        if (cancelled || hasDataRef.current) return;
        const message =
          err instanceof Error ? err.message : "failed to load /api/jobs";
        setResult({ status: "error", message });
      }
    };

    const scheduleRefetch = () => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void refetch();
      }, REFETCH_DEBOUNCE_MS);
    };

    void refetch();

    const source = new EventSource("/api/jobs/events");
    source.addEventListener("open", () => {
      setLive(true);
      scheduleRefetch();
    });
    source.addEventListener("change", scheduleRefetch);
    source.addEventListener("error", () => setLive(false));

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      source.close();
    };
  }, []);

  return { result, live };
}
```

- [ ] **Step 2: `app/_components/JobCard.tsx` を実装**

```tsx
"use client";

import { useState } from "react";
import {
  Ban,
  Check,
  CircleDot,
  HelpCircle,
  Loader2,
  Pause,
  X,
} from "lucide-react";
import type { Job, JobStatus, PendingInput } from "@/lib/jobs/types";

const statusConfig: Record<
  JobStatus,
  { icon: typeof Check; label: string; color: string; bg: string }
> = {
  queued: {
    icon: CircleDot,
    label: "queued",
    color: "text-[var(--signal-idle)]",
    bg: "bg-[var(--hairline)]/40 border-[var(--hairline)]",
  },
  running: {
    icon: Loader2,
    label: "running",
    color: "text-[var(--signal-info)]",
    bg: "bg-[var(--signal-info)]/10 border-[var(--signal-info)]/40",
  },
  waiting_input: {
    icon: Pause,
    label: "needs you",
    color: "text-[var(--signal-alert)]",
    bg: "bg-[var(--signal-alert)]/10 border-[var(--signal-alert)]/40",
  },
  done: {
    icon: Check,
    label: "done",
    color: "text-[var(--signal-ok)]",
    bg: "bg-[var(--signal-ok)]/10 border-[var(--signal-ok)]/40",
  },
  failed: {
    icon: X,
    label: "failed",
    color: "text-[var(--signal-alert)]",
    bg: "bg-[var(--signal-alert)]/10 border-[var(--signal-alert)]/40",
  },
  cancelled: {
    icon: Ban,
    label: "cancelled",
    color: "text-[var(--ink-faint)]",
    bg: "bg-[var(--hairline)]/20 border-[var(--hairline)]",
  },
};

/** permission の内容を人間が判断できる 1 行に要約する */
function summarizeInput(pending: PendingInput): string {
  const input = pending.input as Record<string, unknown> | null;
  if (pending.toolName === "Bash" && typeof input?.command === "string") {
    return input.command;
  }
  if (typeof input?.file_path === "string") return input.file_path;
  return JSON.stringify(input).slice(0, 300);
}

type QuestionInput = {
  questions?: Array<{
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

function PendingInputPanel({ job }: { job: Job }) {
  const pending = job.pendingInput!;
  const [busy, setBusy] = useState(false);
  const [denyMessage, setDenyMessage] = useState("");

  const respond = async (response: unknown) => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/api/jobs/${job.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputId: pending.id, response }),
      });
    } finally {
      setBusy(false);
    }
  };

  if (pending.kind === "question") {
    const questions = (pending.input as QuestionInput).questions ?? [];
    // MVP: 最初の質問の選択肢をボタンで出す (単一質問が実際のほぼ全ケース)
    const q = questions[0];
    return (
      <div className="flex flex-col gap-2 border border-[var(--signal-alert)]/40 bg-[var(--signal-alert)]/5 p-3">
        <div className="text-[13px] font-semibold text-[var(--ink)]">
          {q?.question ?? "エージェントからの質問"}
        </div>
        <div className="flex flex-wrap gap-2">
          {(q?.options ?? []).map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={busy}
              title={option.description}
              onClick={() => respond({ kind: "answers", answers: [[option.label]] })}
              className="border border-[var(--hairline-strong)] px-2.5 py-1 font-mono text-[12px] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border border-[var(--signal-alert)]/40 bg-[var(--signal-alert)]/5 p-3">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--signal-alert)]">
        permission · {pending.toolName}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] text-[var(--ink)]">
        {summarizeInput(pending)}
      </pre>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => respond({ kind: "allow" })}
          className="border border-[var(--signal-ok)]/60 px-2.5 py-1 font-mono text-[12px] text-[var(--signal-ok)] transition hover:bg-[var(--signal-ok)]/10"
        >
          許可
        </button>
        <input
          value={denyMessage}
          onChange={(e) => setDenyMessage(e.target.value)}
          placeholder="拒否理由 (任意)"
          className="min-w-0 flex-1 border border-[var(--hairline)] bg-transparent px-2 py-1 font-mono text-[12px] text-[var(--ink)]"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            respond({ kind: "deny", message: denyMessage || "拒否されました" })
          }
          className="border border-[var(--signal-alert)]/60 px-2.5 py-1 font-mono text-[12px] text-[var(--signal-alert)] transition hover:bg-[var(--signal-alert)]/10"
        >
          拒否
        </button>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function JobCard({ job }: { job: Job }) {
  const s = statusConfig[job.status];
  const Icon = s.icon;
  const [cancelBusy, setCancelBusy] = useState(false);
  const cancellable = ["queued", "running", "waiting_input"].includes(job.status);

  const cancel = async () => {
    if (cancelBusy) return;
    setCancelBusy(true);
    try {
      await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    } finally {
      setCancelBusy(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-2 border px-3 py-2.5 ${
        job.status === "waiting_input"
          ? "border-[var(--signal-alert)]/60"
          : "border-[var(--hairline)]"
      } bg-[var(--background)]`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--ink-muted)]">
            #{job.issueNumber}
          </span>
          <span className="truncate text-[13px] font-semibold text-[var(--ink)]">
            {job.issueTitle}
          </span>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${s.bg} ${s.color}`}
        >
          <Icon
            size={10}
            className={job.status === "running" ? "animate-spin" : undefined}
          />
          {s.label}
        </span>
      </div>

      {job.lastActivity ? (
        <div
          className="truncate font-mono text-[11px] text-[var(--ink-muted)]"
          title={job.lastActivity}
        >
          {job.lastActivity}
        </div>
      ) : null}

      {job.status === "waiting_input" && job.pendingInput ? (
        <PendingInputPanel job={job} />
      ) : null}

      {job.error ? (
        <div className="font-mono text-[11px] text-[var(--signal-alert)]">
          {job.error}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate font-mono text-[11px] text-[var(--ink-dim)]">
            {job.branch}
          </span>
          {job.prUrl ? (
            <a
              href={job.prUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 font-mono text-[11px] text-[var(--accent)] hover:underline"
            >
              PR ↗
            </a>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[10px] text-[var(--ink-muted)]">
            {relativeTime(job.updatedAt)}
          </span>
          {cancellable ? (
            <button
              type="button"
              disabled={cancelBusy}
              onClick={cancel}
              className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-faint)] transition hover:text-[var(--signal-alert)]"
            >
              cancel
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `app/_components/LaunchBoard.tsx` を実装**

```tsx
"use client";

import { useState } from "react";
import { Zap } from "lucide-react";
import type { LaunchIssue } from "@/lib/github/issues";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { JobCard } from "./JobCard";
import { LiveIndicator } from "./useHerdrState";
import { useJobsState } from "./useJobsState";

const ACTIVE = new Set(["queued", "running", "waiting_input"]);

export function LaunchBoard({ issues }: { issues: LaunchIssue[] }) {
  const { result, live } = useJobsState();
  const [firing, setFiring] = useState<number | null>(null);

  const jobs = result.status === "ok" ? result.jobs : [];
  const activeIssueNumbers = new Set(
    jobs.filter((j) => ACTIVE.has(j.status)).map((j) => j.issueNumber),
  );

  const fire = async (issue: LaunchIssue) => {
    if (firing !== null) return;
    setFiring(issue.number);
    try {
      await fetch("/api/jobs/fire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueNumber: issue.number,
          issueTitle: issue.title,
        }),
      });
    } finally {
      setFiring(null);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
          Open Issues
        </h2>
        {issues.length === 0 ? (
          <EmptyState message="open issue はありません" />
        ) : (
          <div className="flex flex-col gap-2">
            {issues.map((issue) => {
              const active = activeIssueNumbers.has(issue.number);
              return (
                <div
                  key={issue.number}
                  className="flex items-center justify-between gap-3 border border-[var(--hairline)] bg-[var(--background)] px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-[11px] text-[var(--ink-muted)]">
                      #{issue.number}
                    </span>
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[13px] font-medium text-[var(--ink)] hover:text-[var(--accent)]"
                    >
                      {issue.title}
                    </a>
                    {issue.labels.map((label) => (
                      <span
                        key={label.name}
                        className="shrink-0 border border-[var(--hairline)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-muted)]"
                      >
                        {label.name}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={active || firing !== null}
                    onClick={() => fire(issue)}
                    className={`inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] transition ${
                      active
                        ? "cursor-default border-[var(--hairline)] text-[var(--ink-faint)]"
                        : "border-[var(--accent)]/60 text-[var(--accent)] hover:bg-[var(--accent)]/10"
                    }`}
                  >
                    <Zap size={11} />
                    {active ? "in flight" : firing === issue.number ? "firing…" : "launch"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
            Jobs
          </h2>
          <LiveIndicator live={live} />
        </div>
        {result.status === "loading" ? (
          <EmptyState message="loading…" />
        ) : result.status === "error" ? (
          <ErrorState
            title="runner unreachable"
            message={`${result.message} — bin/service runner-status で確認`}
          />
        ) : jobs.length === 0 ? (
          <EmptyState message="まだジョブはありません。Issue を launch してください" />
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
```

（`EmptyState` は `{ message: string }`、`ErrorState` は `{ message, title?, hint?, variant?, action? }` — 上のコードは実物と突き合わせ済み）

- [ ] **Step 4: `app/launch/page.tsx` と NavTabs**

`app/launch/page.tsx`（`app/wip/page.tsx` と同構造。Issue フェッチ失敗は throw せず `SectionErrorState` を返すのがこのリポジトリの流儀 — `ErrorState.tsx` のコメント参照）:

```tsx
import { HintTooltip } from "@/app/_components/HintTooltip";
import { LaunchBoard } from "@/app/_components/LaunchBoard";
import { SectionBoundary } from "@/app/_components/SectionBoundary";
import { SectionErrorState } from "@/app/_components/ErrorState";
import { fetchOpenIssues, type LaunchIssue } from "@/lib/github/issues";

export const dynamic = "force-dynamic";

export default async function LaunchPage() {
  let issues: LaunchIssue[] = [];
  let issueError: unknown = null;
  try {
    issues = await fetchOpenIssues();
  } catch (err) {
    issueError = err;
  }

  return (
    <div className="flex-1">
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pt-10 pb-24">
        <div className="flex items-baseline justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
            <h1 className="font-mono text-[18px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
              Launch Pad
            </h1>
            <HintTooltip hint="⚡ fire an issue · headless agent implements it in a worktree · answer permissions here · result lands as a draft PR" />
          </div>
        </div>

        <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />

        <SectionBoundary title="launch pad">
          {issueError ? <SectionErrorState error={issueError} /> : null}
          <LaunchBoard issues={issues} />
        </SectionBoundary>
      </main>
    </div>
  );
}
```

`app/_components/NavTabs.tsx` の NAV 配列に追加:

```ts
const NAV = [
  { href: "/", label: "Board" },
  { href: "/launch", label: "Launch" },
  { href: "/pull-requests", label: "PRs" },
  { href: "/wip", label: "WIP" },
  { href: "/activity", label: "Activity" },
] as const;
```

注意: Issue フェッチ失敗時のフォールバック（`GitHubApiError`）は `page.tsx` を server 側で throw させず、既存ボードがどう処理しているか（`WipBoard` 等の実装）を読んで同じ流儀に合わせること。

- [ ] **Step 5: `app/_components/JobNotifyWatcher.tsx`（PWA 通知）を実装して layout にマウント**

`AgentNotifyWatcher.tsx` と同じ遷移検知パターン。`waiting_input / done / failed` への遷移で通知 + 通知音（`playNotifySound` は `"needsYou" | "done"` の 2 種。waiting_input と failed は needsYou、done は done）:

```tsx
"use client";

import { useEffect, useRef } from "react";
import type { Job, JobStatus } from "@/lib/jobs/types";
import { playNotifySound } from "./notifySound";
import { useJobsState } from "./useJobsState";

const NOTIFY_STATUSES = new Set<JobStatus>(["waiting_input", "done", "failed"]);

function title(job: Job): string {
  switch (job.status) {
    case "waiting_input":
      return `JOB · #${job.issueNumber} — needs your approval`;
    case "done":
      return `JOB · #${job.issueNumber} — PR ready`;
    default:
      return `JOB · #${job.issueNumber} — failed`;
  }
}

// launch ジョブが waiting_input / done / failed に遷移した瞬間に通知する。
// layout に常駐するので、どのページを見ていても届く。
export function JobNotifyWatcher() {
  const { result } = useJobsState();
  const prevRef = useRef<Map<string, JobStatus> | null>(null);

  useEffect(() => {
    if (result.status !== "ok") return;

    const current = new Map(result.jobs.map((j) => [j.id, j.status]));
    const prev = prevRef.current;
    prevRef.current = current;

    // 初回マウント: 既存状態は通知しない (リロード毎のスパム防止)
    if (!prev) return;
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    for (const job of result.jobs) {
      if (!NOTIFY_STATUSES.has(job.status)) continue;
      if (prev.get(job.id) === job.status) continue;

      playNotifySound(job.status === "done" ? "done" : "needsYou");
      const n = new Notification(title(job), {
        body: job.pendingInput?.toolName ?? job.error ?? job.issueTitle,
        icon: job.status === "done" ? "/notify-done.png" : "/notify-blocked.png",
        tag: `cockpit:job:${job.id}:${job.status}`,
        requireInteraction: false,
      });
      n.onclick = () => {
        window.focus();
        window.location.href = "/launch";
        n.close();
      };
    }
  }, [result]);

  return null;
}
```

`app/layout.tsx` の `<AgentNotifyWatcher />`（59 行目付近）の隣に追加:

```tsx
import { JobNotifyWatcher } from "./_components/JobNotifyWatcher";
// ...
          <AgentNotifyWatcher />
          <JobNotifyWatcher />
```

注意: これで runner への SSE 接続が常時 1 本張られる（`/launch` 表示中は 2 本）。localhost なので許容。1 本化したくなったら `HerdrProvider` と同じ Provider パターンに揃える（今回はやらない）。

- [ ] **Step 6: ビルド確認 + 反映**

```bash
pnpm exec tsc --noEmit
pnpm build && bin/service restart
```

ブラウザで `http://localhost:3000/launch` を開き、Issue 一覧（または empty state）と Jobs セクション（runner 停止中なら error state）が出ることを確認。

- [ ] **Step 7: コミット**

```bash
git add app/launch app/layout.tsx app/_components/useJobsState.tsx app/_components/JobCard.tsx app/_components/LaunchBoard.tsx app/_components/JobNotifyWatcher.tsx app/_components/NavTabs.tsx
git commit -m "feat: /launch page — issue list, live job cards, and job notifications

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: dogfood 手動検証（結合テスト）

**Files:** なし（検証のみ。発見したバグは都度修正 + コミット）

**Interfaces:**
- Consumes: 全部

- [ ] **Step 1: 検証用の些細な Issue を作る**

```bash
gh issue create --title "README にスクリーンショットのプレースホルダを追加" \
  --body "READMEの機能セクションの下に、スクリーンショット用の見出しとプレースホルダ文を追加してください。"
```

- [ ] **Step 2: 発射 → 完走の確認**

1. `/launch` で該当 Issue の launch ボタンを押す
2. ジョブカードが `queued → running` と動き、lastActivity が流れること
3. 許可待ちが発生したら PWA 通知が来て、カード上で「許可」できること
4. `done` になり PR リンクが出ること。GitHub 上で draft PR の内容を確認

- [ ] **Step 3: 割り込み系の確認**

1. もう一度別の Issue を発射し、running 中に `bin/service runner-restart`
2. runner 再起動後、ジョブが resume されて続行すること（`waiting_input` 中の再起動も同様に確認。許可が再要求されない場合は spec 記載のリカバリ（resume + 状況説明プロンプト）を workflow.ts に実装する）
3. cancel ボタンでジョブが `cancelled` になり、SDK プロセスが残らないこと（`ps aux | grep claude` で確認）

- [ ] **Step 4: 仕上げ**

1. `pnpm test && pnpm exec tsc --noEmit && pnpm build` が全部通ること
2. 検証で入れた修正をコミット
3. memory の deploy ノートに runner サービスの存在を追記する（`bin/service runner-restart` の反映フロー）
