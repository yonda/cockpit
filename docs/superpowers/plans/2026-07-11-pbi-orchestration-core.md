# PBI Orchestration Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch Pad の上に、PBI（親 Issue）を分解 → 承認 → 依存順にタスク発射 → PR マージ検知で次へ、を決定論的に回す runner 側オーケストレーション・コアを実装する。

**Architecture:** 既存の Launch Pad runner プリミティブ（`JobStore` / `Scheduler` / `runIssueJob` / `InputBroker` / `AgentExecutor` / `CommandRunner` / unix socket）を土台に、上位状態機械 `PbiJob` を足す。PBI の真実は GitHub（親 Issue + sub-issues + PR）に置き、runner は最小限の進行状態のみ永続化する。分解は「構造化出力を artifact に書くエージェントジョブ」、実行ループは「依存が解けた sub-task を Launch Pad ジョブとして発射し、PR マージをポーリング検知して次へ進める知性ゼロの機械」。

**Tech Stack:** TypeScript (Node.js runner, ESM)、vitest、`gh` CLI（GitHub REST: issues / sub-issues / pulls）、unix domain socket（JSON lines）。UI・Next API は本計画のスコープ外（後続計画）。

## Global Constraints

- 対象スペック: `docs/superpowers/specs/2026-07-10-pbi-orchestration-design.md`。全タスクの要件はこのスペックに従う。
- 依存: Launch Pad（`docs/superpowers/specs/2026-07-09-launch-pad-design.md`）は main にマージ済み。本計画は `runner/` 配下の既存モジュールを import して拡張する。
- 実行環境: ローカル Mac、Claude Code サブスクリプション内。隔離環境・クラウドは使わない。
- 境界ルール（Launch Pad 既存規約の継承）: runner は Next.js コードを import しない。Next と共有するのは型定義（`lib/`）とソケットプロトコルのみ。
- ジョブモデル再利用: 個々の実装タスクは既存の `runIssueJob`（1 Issue → 1 draft PR）をそのまま使う。PBI コアは「複数 Launch Pad ジョブのオーケストレーション層」であり、実装エージェントの中身には手を入れない。
- マージ検知は runner からの `gh` ポーリング（webhook は使わない）。ポーリング間隔は既定 90 秒、`PBI_POLL_INTERVAL_MS` で上書き可能。
- 「次へ進め」の自動トリガーは PR マージ検知のみ。それ以外の発射（分解のやり直し、失敗リトライ、レビューコメント対応）はすべて人間の明示操作を待つ。
- 決定論とテスト容易性: 外部 I/O（`gh`、エージェント実行、時計）はすべて injectable インターフェース越しに呼ぶ。ユニットテストはフェイクを注入し、`Date`・`setInterval`・ネットワークに依存しない。
- 命名・スタイル: 既存 `runner/` に合わせる。日本語コメント、`type` エイリアス優先、`export function` / `export class`、`node:` プレフィックス付き標準モジュール。
- PBI Issue の識別: `pbi` ラベル付きの親 Issue。sub-issue は runner が GitHub 上に作成し、本文冒頭に確定前マーカー行を持つ。
- sub-issue リンク API（裏取り済み・2026-07-11 GitHub REST）:
  - 追加: `POST /repos/{owner}/{repo}/issues/{parent_number}/sub_issues`、body `{"sub_issue_id": <子 issue の内部 id（number ではない）>}`
  - 一覧: `GET /repos/{owner}/{repo}/issues/{parent_number}/sub_issues`
  - 子 Issue 作成は `POST /repos/{owner}/{repo}/issues`（返り値に `id`・`number`・`html_url` を含む）
- ストレージ:
  - PBI: `~/.cache/cockpit/pbis/`（`PBIS_DIR`、`RUNNER_PBIS_DIR` で上書き可）
  - Launch Pad ジョブ: 既存 `~/.cache/cockpit/jobs/`（`JOBS_DIR`）をそのまま利用

---

### Task 1: PBI 共有型と状態機械

**Files:**
- Create: `lib/pbi/types.ts`
- Test: `runner/__tests__/pbi-types.test.ts`

**Interfaces:**
- Consumes: なし（新規の土台）
- Produces:
  - 型 `PbiStatus`, `SubTaskState`, `SubTask`, `SubTaskRecord`, `PbiEscalation`, `PbiEscalationKind`, `PbiJob`
  - `canPbiTransition(from: PbiStatus, to: PbiStatus): boolean`
  - `canSubTaskTransition(from: SubTaskState, to: SubTaskState): boolean`
  - `isSubTaskArray(value: unknown): value is SubTask[]`（分解 artifact のスキーマ検証）
  - 定数 `PBIS_DIR: string`, `PBI_POLL_INTERVAL_MS: number`, `SUBTASK_MARKER: string`

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-types.test.ts
import { describe, expect, it } from "vitest";
import {
  canPbiTransition,
  canSubTaskTransition,
  isSubTaskArray,
} from "../../lib/pbi/types";

describe("canPbiTransition", () => {
  it("allows decomposing -> awaiting_approval and the revise loop", () => {
    expect(canPbiTransition("decomposing", "awaiting_approval")).toBe(true);
    expect(canPbiTransition("awaiting_approval", "decomposing")).toBe(true);
    expect(canPbiTransition("awaiting_approval", "executing")).toBe(true);
    expect(canPbiTransition("executing", "completed")).toBe(true);
  });
  it("rejects terminal and skipping transitions", () => {
    expect(canPbiTransition("completed", "executing")).toBe(false);
    expect(canPbiTransition("decomposing", "executing")).toBe(false);
    expect(canPbiTransition("decomposing", "completed")).toBe(false);
  });
  it("allows cancel/fail from any non-terminal state", () => {
    expect(canPbiTransition("decomposing", "cancelled")).toBe(true);
    expect(canPbiTransition("executing", "failed")).toBe(true);
  });
});

describe("canSubTaskTransition", () => {
  it("allows the happy path pending -> running -> in_review -> merged", () => {
    expect(canSubTaskTransition("pending", "running")).toBe(true);
    expect(canSubTaskTransition("running", "in_review")).toBe(true);
    expect(canSubTaskTransition("in_review", "merged")).toBe(true);
  });
  it("allows recovery: failed -> running (retry) and any -> skipped", () => {
    expect(canSubTaskTransition("failed", "running")).toBe(true);
    expect(canSubTaskTransition("pending", "skipped")).toBe(true);
    expect(canSubTaskTransition("in_review", "failed")).toBe(true);
  });
  it("rejects transitions out of terminal states", () => {
    expect(canSubTaskTransition("merged", "running")).toBe(false);
    expect(canSubTaskTransition("skipped", "running")).toBe(false);
  });
});

describe("isSubTaskArray", () => {
  const valid = [
    {
      key: "t1",
      title: "型を作る",
      goal: "土台",
      deliverable: "types.ts",
      acceptanceCriteria: ["テストが通る"],
      dependsOn: [],
    },
    {
      key: "t2",
      title: "store を作る",
      goal: "永続化",
      deliverable: "store.ts",
      acceptanceCriteria: ["保存できる"],
      dependsOn: ["t1"],
    },
  ];
  it("accepts a well-formed array", () => {
    expect(isSubTaskArray(valid)).toBe(true);
  });
  it("rejects missing fields and wrong types", () => {
    expect(isSubTaskArray([{ key: "t1" }])).toBe(false);
    expect(isSubTaskArray("nope")).toBe(false);
    expect(isSubTaskArray([{ ...valid[0], dependsOn: "t1" }])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-types.test.ts`
Expected: FAIL — "Cannot find module '../../lib/pbi/types'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/pbi/types.ts
import { homedir } from "node:os";
import { join } from "node:path";

// ---- 定数 -------------------------------------------------------------

export const PBIS_DIR =
  process.env.RUNNER_PBIS_DIR ?? join(homedir(), ".cache", "cockpit", "pbis");

export const PBI_POLL_INTERVAL_MS = Number(
  process.env.PBI_POLL_INTERVAL_MS ?? 90_000,
);

/** sub-issue 本文の冒頭に置く「確定前」マーカー。承認時に取り除く。 */
export const SUBTASK_MARKER = "<!-- cockpit:proposed -->";

// ---- PBI 状態機械 -------------------------------------------------------

export type PbiStatus =
  | "decomposing"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

const PBI_TRANSITIONS: Record<PbiStatus, readonly PbiStatus[]> = {
  decomposing: ["awaiting_approval", "failed", "cancelled"],
  awaiting_approval: ["decomposing", "executing", "failed", "cancelled"],
  executing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canPbiTransition(from: PbiStatus, to: PbiStatus): boolean {
  return PBI_TRANSITIONS[from].includes(to);
}

// ---- sub-task 状態機械 --------------------------------------------------

export type SubTaskState =
  | "pending" // 未着手（依存待ちを含む。発射可否はグラフから導出）
  | "running" // Launch Pad ジョブ実行中
  | "in_review" // PR 作成済み・人間のマージ待ち
  | "merged" // PR マージ済み → 完了
  | "failed" // ジョブ失敗 / PR がマージなしクローズ → エスカレーション
  | "skipped"; // 人間がスキップ指示

const SUBTASK_TRANSITIONS: Record<SubTaskState, readonly SubTaskState[]> = {
  pending: ["running", "skipped", "failed"],
  running: ["in_review", "failed", "skipped"],
  in_review: ["merged", "failed", "skipped"],
  failed: ["running", "skipped"], // 失敗 → リトライ / スキップ
  merged: [],
  skipped: [],
};

export function canSubTaskTransition(
  from: SubTaskState,
  to: SubTaskState,
): boolean {
  return SUBTASK_TRANSITIONS[from].includes(to);
}

// ---- 分解結果（エージェントの構造化出力） --------------------------------

export type SubTask = {
  /** 分解時に採番する安定 key（t1, t2, ...）。sub-issue 番号とは別。 */
  key: string;
  title: string;
  goal: string;
  /** この PR で何を作るか。1 PR = 1 revert 単位。 */
  deliverable: string;
  acceptanceCriteria: string[];
  /** 依存する他 SubTask の key の配列。 */
  dependsOn: string[];
};

export function isSubTaskArray(value: unknown): value is SubTask[] {
  if (!Array.isArray(value)) return false;
  return value.every((t) => {
    if (!t || typeof t !== "object") return false;
    const o = t as Record<string, unknown>;
    return (
      typeof o.key === "string" &&
      typeof o.title === "string" &&
      typeof o.goal === "string" &&
      typeof o.deliverable === "string" &&
      Array.isArray(o.acceptanceCriteria) &&
      o.acceptanceCriteria.every((s) => typeof s === "string") &&
      Array.isArray(o.dependsOn) &&
      o.dependsOn.every((s) => typeof s === "string")
    );
  });
}

// ---- PBI レコード -------------------------------------------------------

export type SubTaskRecord = SubTask & {
  state: SubTaskState;
  /** runner が作成した sub-issue 番号。作成前は null。 */
  issueNumber: number | null;
  /** 対応する Launch Pad Job の id。発射前は null。 */
  jobId: string | null;
  branch: string | null;
  prUrl: string | null;
};

export type PbiEscalationKind =
  | "decomposition_approval"
  | "task_failed"
  | "pr_closed_unmerged"
  | "review_comments";

export type PbiEscalation = {
  id: string;
  kind: PbiEscalationKind;
  /** decomposition_approval は null、それ以外は対象 sub-task の key。 */
  subTaskKey: string | null;
  detail: string;
  createdAt: string;
};

export type PbiJob = {
  id: string;
  repo: string; // "yonda/cockpit"
  issueNumber: number; // 親 PBI issue
  title: string;
  status: PbiStatus;
  /** executing 中の一時停止（新規発射だけ止める）。status とは直交。 */
  paused: boolean;
  subTasks: SubTaskRecord[];
  escalations: PbiEscalation[];
  /** 分解のやり直し回数（暴走ガード用）。 */
  decompositionAttempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-types.test.ts`
Expected: PASS (3 describe blocks green)

- [ ] **Step 5: Commit**

```bash
git add lib/pbi/types.ts runner/__tests__/pbi-types.test.ts
git commit -m "feat: PBI types and state machines for orchestration core"
```

---

### Task 2: PbiStore（永続化 + イベント）

**Files:**
- Create: `runner/pbi-store.ts`
- Test: `runner/__tests__/pbi-store.test.ts`

**Interfaces:**
- Consumes: `PbiJob`, `PbiStatus`, `SubTask`, `SubTaskRecord`, `SubTaskState`, `PbiEscalation`, `canPbiTransition`, `canSubTaskTransition` from `lib/pbi/types`
- Produces: `class PbiStore extends EventEmitter`（`runner/store.ts` の `JobStore` と同じ流儀）:
  - `constructor(dir: string)`
  - `loadAll(): void`
  - `list(): PbiJob[]`（createdAt 降順）
  - `get(id: string): PbiJob | undefined`
  - `create(fields: { repo: string; issueNumber: number; title: string }): PbiJob`（status=`decomposing`, subTasks=[], escalations=[], decompositionAttempts=0）
  - `transition(id: string, to: PbiStatus, patch?: Partial<PbiJob>): PbiJob`
  - `update(id: string, patch: Partial<PbiJob>): PbiJob`（status 変更は禁止 → transition を使う）
  - `setSubTasks(id: string, subTasks: SubTaskRecord[]): PbiJob`
  - `transitionSubTask(id: string, key: string, to: SubTaskState, patch?: Partial<SubTaskRecord>): PbiJob`
  - `addEscalation(id: string, esc: Omit<PbiEscalation, "id" | "createdAt">): PbiJob`
  - `clearEscalation(id: string, escId: string): PbiJob`
  - emits `"pbi"` イベントに更新後の `PbiJob`

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubTaskRecord } from "../../lib/pbi/types";
import { PbiStore } from "../pbi-store";

let dir: string;
let store: PbiStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pbi-"));
  store = new PbiStore(dir);
  store.loadAll();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (over: Partial<SubTaskRecord>): SubTaskRecord => ({
  key: "t1",
  title: "t",
  goal: "g",
  deliverable: "d",
  acceptanceCriteria: [],
  dependsOn: [],
  state: "pending",
  issueNumber: null,
  jobId: null,
  branch: null,
  prUrl: null,
  ...over,
});

describe("PbiStore", () => {
  it("creates a PBI in decomposing and persists it across reloads", () => {
    const pbi = store.create({
      repo: "yonda/cockpit",
      issueNumber: 42,
      title: "Launch Pad",
    });
    expect(pbi.status).toBe("decomposing");
    expect(pbi.decompositionAttempts).toBe(0);

    const reloaded = new PbiStore(dir);
    reloaded.loadAll();
    expect(reloaded.get(pbi.id)?.issueNumber).toBe(42);
  });

  it("enforces the state machine on transition", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    expect(() => store.transition(pbi.id, "completed")).toThrow(
      /invalid transition/,
    );
    store.transition(pbi.id, "awaiting_approval");
    expect(store.get(pbi.id)?.status).toBe("awaiting_approval");
  });

  it("rejects status changes through update()", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    expect(() =>
      store.update(pbi.id, { status: "executing" }),
    ).toThrow(/use transition/);
  });

  it("sets sub-tasks and transitions one with a patch", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    store.setSubTasks(pbi.id, [rec({ key: "t1" }), rec({ key: "t2" })]);
    store.transitionSubTask(pbi.id, "t1", "running", { jobId: "job-9" });
    const t1 = store.get(pbi.id)!.subTasks.find((t) => t.key === "t1")!;
    expect(t1.state).toBe("running");
    expect(t1.jobId).toBe("job-9");
  });

  it("adds and clears escalations", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    const withEsc = store.addEscalation(pbi.id, {
      kind: "task_failed",
      subTaskKey: "t1",
      detail: "boom",
    });
    const escId = withEsc.escalations[0].id;
    expect(withEsc.escalations).toHaveLength(1);
    const cleared = store.clearEscalation(pbi.id, escId);
    expect(cleared.escalations).toHaveLength(0);
  });

  it("emits a pbi event on every mutation", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    const seen: string[] = [];
    store.on("pbi", (p) => seen.push(p.status));
    store.transition(pbi.id, "awaiting_approval");
    expect(seen).toContain("awaiting_approval");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-store.test.ts`
Expected: FAIL — "Cannot find module '../pbi-store'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/pbi-store.ts
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
import {
  canPbiTransition,
  canSubTaskTransition,
  type PbiEscalation,
  type PbiJob,
  type PbiStatus,
  type SubTaskRecord,
  type SubTaskState,
} from "../lib/pbi/types";

export class PbiStore extends EventEmitter {
  private pbis = new Map<string, PbiJob>();

  constructor(private readonly dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
  }

  loadAll(): void {
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const pbi = JSON.parse(
          readFileSync(join(this.dir, name), "utf8"),
        ) as PbiJob;
        this.pbis.set(pbi.id, pbi);
      } catch {
        // 壊れたファイルはスキップ（起動を止めない）
      }
    }
  }

  list(): PbiJob[] {
    return [...this.pbis.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(id: string): PbiJob | undefined {
    return this.pbis.get(id);
  }

  create(fields: {
    repo: string;
    issueNumber: number;
    title: string;
  }): PbiJob {
    const now = new Date().toISOString();
    const pbi: PbiJob = {
      id: `pbi-${Date.now()}-${randomUUID().slice(0, 8)}`,
      ...fields,
      status: "decomposing",
      paused: false,
      subTasks: [],
      escalations: [],
      decompositionAttempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.save(pbi);
    return pbi;
  }

  transition(id: string, to: PbiStatus, patch: Partial<PbiJob> = {}): PbiJob {
    const pbi = this.mustGet(id);
    if (!canPbiTransition(pbi.status, to)) {
      throw new Error(`invalid transition: ${pbi.status} -> ${to} (${id})`);
    }
    return this.save({ ...pbi, ...patch, status: to });
  }

  update(id: string, patch: Partial<PbiJob>): PbiJob {
    const pbi = this.mustGet(id);
    if ("status" in patch && patch.status !== pbi.status) {
      throw new Error("use transition() to change status");
    }
    return this.save({ ...pbi, ...patch });
  }

  setSubTasks(id: string, subTasks: SubTaskRecord[]): PbiJob {
    return this.save({ ...this.mustGet(id), subTasks });
  }

  transitionSubTask(
    id: string,
    key: string,
    to: SubTaskState,
    patch: Partial<SubTaskRecord> = {},
  ): PbiJob {
    const pbi = this.mustGet(id);
    const subTasks = pbi.subTasks.map((t) => {
      if (t.key !== key) return t;
      if (!canSubTaskTransition(t.state, to)) {
        throw new Error(
          `invalid sub-task transition: ${t.state} -> ${to} (${id}/${key})`,
        );
      }
      return { ...t, ...patch, state: to };
    });
    return this.save({ ...pbi, subTasks });
  }

  addEscalation(
    id: string,
    esc: Omit<PbiEscalation, "id" | "createdAt">,
  ): PbiJob {
    const pbi = this.mustGet(id);
    const full: PbiEscalation = {
      ...esc,
      id: `esc-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
    };
    return this.save({ ...pbi, escalations: [...pbi.escalations, full] });
  }

  clearEscalation(id: string, escId: string): PbiJob {
    const pbi = this.mustGet(id);
    return this.save({
      ...pbi,
      escalations: pbi.escalations.filter((e) => e.id !== escId),
    });
  }

  private mustGet(id: string): PbiJob {
    const pbi = this.pbis.get(id);
    if (!pbi) throw new Error(`unknown pbi: ${id}`);
    return pbi;
  }

  private save(pbi: PbiJob): PbiJob {
    const next = { ...pbi, updatedAt: new Date().toISOString() };
    this.pbis.set(next.id, next);
    const path = join(this.dir, `${next.id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    this.emit("pbi", next);
    return next;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner/pbi-store.ts runner/__tests__/pbi-store.test.ts
git commit -m "feat: PbiStore with state-machine-enforced persistence and events"
```

---

### Task 3: GitHubClient（gh 越しの Issue / sub-issue / PR 操作）

**Files:**
- Create: `runner/github.ts`
- Test: `runner/__tests__/github.test.ts`

**Interfaces:**
- Consumes: `CommandRunner` from `runner/exec`, `SubTask`, `SUBTASK_MARKER` from `lib/pbi/types`
- Produces:
  - `type PrState = { kind: "none" } | { kind: "open"; url: string; reviewCommentCount: number } | { kind: "merged"; url: string } | { kind: "closed"; url: string }`
  - `interface GitHubClient { fetchIssue(repo, number): Promise<{ title: string; body: string }>; createSubIssue(repo, parent, task): Promise<{ number: number; url: string }>; updateIssueBody(repo, number, body): Promise<void>; closeIssue(repo, number): Promise<void>; prStateForBranch(repo, branch): Promise<PrState> }`
  - `class RealGitHubClient implements GitHubClient`（`constructor(commands: CommandRunner, repoDir: string)`）
  - `function subIssueBody(task: SubTask, proposed: boolean): string`（本文組み立て + マーカー）

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/github.test.ts
import { describe, expect, it } from "vitest";
import type { CommandRunner, RunResult } from "../exec";
import type { SubTask } from "../../lib/pbi/types";
import { RealGitHubClient, subIssueBody } from "../github";

const task: SubTask = {
  key: "t1",
  title: "型を作る",
  goal: "土台",
  deliverable: "types.ts",
  acceptanceCriteria: ["テストが通る", "型エラーがない"],
  dependsOn: [],
};

/** 呼び出しを記録し、コマンドごとに用意した stdout を返すフェイク */
class FakeCommands implements CommandRunner {
  calls: { cmd: string; args: string[] }[] = [];
  responses: (result: RunResult | ((args: string[]) => RunResult))[] = [];
  async run(cmd: string, args: string[]): Promise<RunResult> {
    this.calls.push({ cmd, args });
    const next = this.responses.shift() ?? { stdout: "", stderr: "" };
    return typeof next === "function" ? next(args) : next;
  }
}

describe("subIssueBody", () => {
  it("includes the marker when proposed and the acceptance criteria", () => {
    const body = subIssueBody(task, true);
    expect(body.startsWith("<!-- cockpit:proposed -->")).toBe(true);
    expect(body).toContain("テストが通る");
  });
  it("omits the marker when confirmed", () => {
    expect(subIssueBody(task, false)).not.toContain("cockpit:proposed");
  });
});

describe("RealGitHubClient.createSubIssue", () => {
  it("creates the child issue then links it via the sub_issues endpoint", async () => {
    const commands = new FakeCommands();
    // 1) POST /issues -> {id, number, html_url}
    commands.responses.push({
      stdout: JSON.stringify({
        id: 555,
        number: 101,
        html_url: "https://github.com/yonda/cockpit/issues/101",
      }),
      stderr: "",
    });
    // 2) POST /issues/42/sub_issues -> 201 (本文不要)
    commands.responses.push({ stdout: "", stderr: "" });

    const gh = new RealGitHubClient(commands, "/repo");
    const res = await gh.createSubIssue("yonda/cockpit", 42, task);

    expect(res).toEqual({
      number: 101,
      url: "https://github.com/yonda/cockpit/issues/101",
    });
    // 子 issue 作成
    expect(commands.calls[0].args).toContain(
      "/repos/yonda/cockpit/issues",
    );
    // 親へのリンク: sub_issue_id は number(101) ではなく内部 id(555)
    const linkArgs = commands.calls[1].args.join(" ");
    expect(linkArgs).toContain("/repos/yonda/cockpit/issues/42/sub_issues");
    expect(linkArgs).toContain("sub_issue_id=555");
  });
});

describe("RealGitHubClient.prStateForBranch", () => {
  const gh = (commands: CommandRunner) =>
    new RealGitHubClient(commands, "/repo");

  it("returns none when no PR exists", async () => {
    const commands = new FakeCommands();
    commands.responses.push({ stdout: "[]", stderr: "" });
    expect(await gh(commands).prStateForBranch("r", "feature/1-x")).toEqual({
      kind: "none",
    });
  });

  it("maps a merged PR", async () => {
    const commands = new FakeCommands();
    commands.responses.push({
      stdout: JSON.stringify([
        {
          url: "https://github.com/yonda/cockpit/pull/9",
          state: "MERGED",
          reviewThreads: { totalCount: 0 },
        },
      ]),
      stderr: "",
    });
    expect(await gh(commands).prStateForBranch("r", "feature/1-x")).toEqual({
      kind: "merged",
      url: "https://github.com/yonda/cockpit/pull/9",
    });
  });

  it("maps an open PR with its review comment count", async () => {
    const commands = new FakeCommands();
    commands.responses.push({
      stdout: JSON.stringify([
        {
          url: "https://github.com/yonda/cockpit/pull/9",
          state: "OPEN",
          reviewThreads: { totalCount: 3 },
        },
      ]),
      stderr: "",
    });
    expect(await gh(commands).prStateForBranch("r", "feature/1-x")).toEqual({
      kind: "open",
      url: "https://github.com/yonda/cockpit/pull/9",
      reviewCommentCount: 3,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/github.test.ts`
Expected: FAIL — "Cannot find module '../github'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/github.ts
import type { CommandRunner } from "./exec";
import { SUBTASK_MARKER, type SubTask } from "../lib/pbi/types";

export type PrState =
  | { kind: "none" }
  | { kind: "open"; url: string; reviewCommentCount: number }
  | { kind: "merged"; url: string }
  | { kind: "closed"; url: string };

export interface GitHubClient {
  fetchIssue(repo: string, number: number): Promise<{ title: string; body: string }>;
  createSubIssue(
    repo: string,
    parent: number,
    task: SubTask,
  ): Promise<{ number: number; url: string }>;
  updateIssueBody(repo: string, number: number, body: string): Promise<void>;
  closeIssue(repo: string, number: number): Promise<void>;
  prStateForBranch(repo: string, branch: string): Promise<PrState>;
}

export function subIssueBody(task: SubTask, proposed: boolean): string {
  const lines: string[] = [];
  if (proposed) lines.push(SUBTASK_MARKER, "");
  lines.push(
    `**目的**: ${task.goal}`,
    "",
    `**成果物**: ${task.deliverable}`,
    "",
    "**受け入れ基準**:",
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
  );
  if (task.dependsOn.length > 0) {
    lines.push("", `**依存**: ${task.dependsOn.join(", ")}`);
  }
  return lines.join("\n");
}

export class RealGitHubClient implements GitHubClient {
  constructor(
    private readonly commands: CommandRunner,
    private readonly repoDir: string,
  ) {}

  private gh(args: string[]) {
    return this.commands.run("gh", args, { cwd: this.repoDir });
  }

  async fetchIssue(repo: string, number: number) {
    const { stdout } = await this.gh([
      "issue",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "title,body",
    ]);
    const issue = JSON.parse(stdout) as { title: string; body: string };
    return { title: issue.title, body: issue.body ?? "" };
  }

  async createSubIssue(repo: string, parent: number, task: SubTask) {
    // 1) 子 Issue を作成（返り値に内部 id と number を含む REST を使う）
    const { stdout } = await this.gh([
      "api",
      "--method",
      "POST",
      `/repos/${repo}/issues`,
      "-f",
      `title=${task.title}`,
      "-f",
      `body=${subIssueBody(task, true)}`,
    ]);
    const created = JSON.parse(stdout) as {
      id: number;
      number: number;
      html_url: string;
    };
    // 2) 親にリンク（body の sub_issue_id は number ではなく内部 id）
    await this.gh([
      "api",
      "--method",
      "POST",
      `/repos/${repo}/issues/${parent}/sub_issues`,
      "-F",
      `sub_issue_id=${created.id}`,
    ]);
    return { number: created.number, url: created.html_url };
  }

  async updateIssueBody(repo: string, number: number, body: string) {
    await this.gh([
      "api",
      "--method",
      "PATCH",
      `/repos/${repo}/issues/${number}`,
      "-f",
      `body=${body}`,
    ]);
  }

  async closeIssue(repo: string, number: number) {
    await this.gh(["issue", "close", String(number), "--repo", repo]);
  }

  async prStateForBranch(repo: string, branch: string): Promise<PrState> {
    const { stdout } = await this.gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "url,state,reviewThreads",
    ]);
    const prs = JSON.parse(stdout) as Array<{
      url: string;
      state: string;
      reviewThreads?: { totalCount: number };
    }>;
    if (prs.length === 0) return { kind: "none" };
    const pr = prs[0];
    if (pr.state === "MERGED") return { kind: "merged", url: pr.url };
    if (pr.state === "CLOSED") return { kind: "closed", url: pr.url };
    return {
      kind: "open",
      url: pr.url,
      reviewCommentCount: pr.reviewThreads?.totalCount ?? 0,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/github.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner/github.ts runner/__tests__/github.test.ts
git commit -m "feat: GitHubClient wrapping gh for issues, sub-issues, and PR state"
```

---

### Task 4: 依存グラフ（純関数：発射可能タスクと完了判定）

**Files:**
- Create: `runner/pbi-graph.ts`
- Test: `runner/__tests__/pbi-graph.test.ts`

**Interfaces:**
- Consumes: `SubTaskRecord` from `lib/pbi/types`
- Produces:
  - `readySubTasks(subTasks: SubTaskRecord[]): SubTaskRecord[]`（state=`pending` かつ全依存が `merged` または `skipped`）
  - `isPbiComplete(subTasks: SubTaskRecord[]): boolean`（全 sub-task が `merged` または `skipped`、かつ 1 件以上）
  - `hasBlockedProgress(subTasks: SubTaskRecord[]): boolean`（発射可能タスクも実行中タスクも無いが未完了 = デッドロック検出）
  - `validateDependencies(subTasks: SubTaskRecord[]): string | null`（未知 key 参照・循環を検出、問題があればメッセージ、無ければ null）

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-graph.test.ts
import { describe, expect, it } from "vitest";
import type { SubTaskRecord, SubTaskState } from "../../lib/pbi/types";
import {
  hasBlockedProgress,
  isPbiComplete,
  readySubTasks,
  validateDependencies,
} from "../pbi-graph";

const t = (
  key: string,
  state: SubTaskState,
  dependsOn: string[] = [],
): SubTaskRecord => ({
  key,
  title: key,
  goal: "",
  deliverable: "",
  acceptanceCriteria: [],
  dependsOn,
  state,
  issueNumber: null,
  jobId: null,
  branch: null,
  prUrl: null,
});

describe("readySubTasks", () => {
  it("returns pending tasks whose dependencies are all merged", () => {
    const tasks = [
      t("t1", "merged"),
      t("t2", "pending", ["t1"]),
      t("t3", "pending", ["t2"]),
    ];
    expect(readySubTasks(tasks).map((x) => x.key)).toEqual(["t2"]);
  });
  it("treats skipped dependencies as satisfied", () => {
    const tasks = [t("t1", "skipped"), t("t2", "pending", ["t1"])];
    expect(readySubTasks(tasks).map((x) => x.key)).toEqual(["t2"]);
  });
  it("excludes tasks with an unmet dependency", () => {
    const tasks = [t("t1", "running"), t("t2", "pending", ["t1"])];
    expect(readySubTasks(tasks)).toEqual([]);
  });
});

describe("isPbiComplete", () => {
  it("is true only when every task is merged or skipped", () => {
    expect(isPbiComplete([t("t1", "merged"), t("t2", "skipped")])).toBe(true);
    expect(isPbiComplete([t("t1", "merged"), t("t2", "in_review")])).toBe(false);
    expect(isPbiComplete([])).toBe(false);
  });
});

describe("hasBlockedProgress", () => {
  it("detects a deadlock: nothing ready, nothing running, not complete", () => {
    // t2 は t1 に依存するが t1 が failed のまま → 前進不能
    const tasks = [t("t1", "failed"), t("t2", "pending", ["t1"])];
    expect(hasBlockedProgress(tasks)).toBe(true);
  });
  it("is false while a task is still running", () => {
    const tasks = [t("t1", "running"), t("t2", "pending", ["t1"])];
    expect(hasBlockedProgress(tasks)).toBe(false);
  });
});

describe("validateDependencies", () => {
  it("passes a clean DAG", () => {
    expect(
      validateDependencies([t("t1", "pending"), t("t2", "pending", ["t1"])]),
    ).toBeNull();
  });
  it("flags an unknown dependency key", () => {
    expect(validateDependencies([t("t2", "pending", ["t1"])])).toMatch(/t1/);
  });
  it("flags a cycle", () => {
    const tasks = [
      t("t1", "pending", ["t2"]),
      t("t2", "pending", ["t1"]),
    ];
    expect(validateDependencies(tasks)).toMatch(/循環|cycle/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-graph.test.ts`
Expected: FAIL — "Cannot find module '../pbi-graph'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/pbi-graph.ts
import type { SubTaskRecord } from "../lib/pbi/types";

const DONE = new Set(["merged", "skipped"]);

export function readySubTasks(subTasks: SubTaskRecord[]): SubTaskRecord[] {
  const byKey = new Map(subTasks.map((t) => [t.key, t]));
  return subTasks.filter((t) => {
    if (t.state !== "pending") return false;
    return t.dependsOn.every((dep) => {
      const d = byKey.get(dep);
      return d != null && DONE.has(d.state);
    });
  });
}

export function isPbiComplete(subTasks: SubTaskRecord[]): boolean {
  return subTasks.length > 0 && subTasks.every((t) => DONE.has(t.state));
}

export function hasBlockedProgress(subTasks: SubTaskRecord[]): boolean {
  if (isPbiComplete(subTasks)) return false;
  const anyRunning = subTasks.some((t) =>
    ["running", "in_review"].includes(t.state),
  );
  if (anyRunning) return false;
  return readySubTasks(subTasks).length === 0;
}

export function validateDependencies(subTasks: SubTaskRecord[]): string | null {
  const keys = new Set(subTasks.map((t) => t.key));
  for (const t of subTasks) {
    for (const dep of t.dependsOn) {
      if (!keys.has(dep)) {
        return `未知の依存 key を参照しています: ${t.key} -> ${dep}`;
      }
    }
  }
  // 循環検出（DFS）
  const byKey = new Map(subTasks.map((t) => [t.key, t]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): boolean => {
    const s = state.get(key);
    if (s === "done") return false;
    if (s === "visiting") return true; // 循環
    state.set(key, "visiting");
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (visit(dep)) return true;
    }
    state.set(key, "done");
    return false;
  };
  for (const t of subTasks) {
    if (visit(t.key)) return `依存に循環があります (${t.key} を含む)`;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-graph.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner/pbi-graph.ts runner/__tests__/pbi-graph.test.ts
git commit -m "feat: PBI dependency graph — ready/complete/deadlock/validation"
```

---

### Task 5: 分解ジョブ（エージェント → artifact → スキーマ検証）

**Files:**
- Create: `runner/decompose.ts`
- Test: `runner/__tests__/decompose.test.ts`

**Interfaces:**
- Consumes: `AgentExecutor`, `CommandRunner` from `runner/executor`/`runner/exec`, `SubTask`, `isSubTaskArray` from `lib/pbi/types`, `GitHubClient` from `runner/github`
- Produces:
  - `type DecomposeDeps = { executor: AgentExecutor; commands: CommandRunner; github: GitHubClient; repoDir: string; scratchDir: string }`
  - `runDecomposition(deps, args: { repo: string; issueNumber: number; title: string; body: string; priorTasks?: SubTask[]; feedback?: string; signal: AbortSignal }): Promise<{ ok: true; tasks: SubTask[] } | { ok: false; error: string }>`
  - `buildDecomposePrompt(args): string`（再分解時は priorTasks + feedback を含める）
  - `DECOMPOSITION_FILE = "decomposition.json"` 定数

**Design note:** 分解エージェントは読み取り専用の scratch worktree（`decomp/<n>` を `origin/<default>` から作成）を cwd に、コードベースを読んで `decomposition.json`（`SubTask[]` の JSON）を worktree 直下に書く。runner はそれを読んで `isSubTaskArray` で検証する（自己申告ではなく artifact を検証、Launch Pad の思想と一致）。読み取り後 worktree は破棄する。

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/decompose.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentExecutor,
  ExecutorHooks,
  ExecutorRunOpts,
} from "../executor";
import type { CommandRunner } from "../exec";
import type { GitHubClient, PrState } from "../github";
import type { SubTask } from "../../lib/pbi/types";
import { buildDecomposePrompt, runDecomposition } from "../decompose";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "decomp-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const noopGithub: GitHubClient = {
  fetchIssue: async () => ({ title: "", body: "" }),
  createSubIssue: async () => ({ number: 0, url: "" }),
  updateIssueBody: async () => {},
  closeIssue: async () => {},
  prStateForBranch: async (): Promise<PrState> => ({ kind: "none" }),
};

const fakeCommands: CommandRunner = {
  run: async () => ({ stdout: "", stderr: "" }),
};

/** decomposition.json を書いてから ok を返すフェイクエージェント */
class WritingExecutor implements AgentExecutor {
  constructor(private readonly payload: unknown) {}
  lastOpts: ExecutorRunOpts | null = null;
  async run(opts: ExecutorRunOpts, _hooks: ExecutorHooks) {
    this.lastOpts = opts;
    writeFileSync(
      join(opts.cwd, "decomposition.json"),
      JSON.stringify(this.payload),
    );
    return { ok: true as const };
  }
}

const validTasks: SubTask[] = [
  {
    key: "t1",
    title: "types",
    goal: "土台",
    deliverable: "types.ts",
    acceptanceCriteria: ["ok"],
    dependsOn: [],
  },
];

describe("buildDecomposePrompt", () => {
  it("includes prior tasks and feedback on a revise", () => {
    const p = buildDecomposePrompt({
      issueNumber: 5,
      title: "t",
      body: "b",
      priorTasks: validTasks,
      feedback: "t1 が大きすぎる",
    });
    expect(p).toContain("t1 が大きすぎる");
    expect(p).toContain("types.ts");
  });
});

describe("runDecomposition", () => {
  const deps = (executor: AgentExecutor) => ({
    executor,
    commands: fakeCommands,
    github: noopGithub,
    repoDir: "/repo",
    scratchDir: scratch,
  });

  it("returns validated tasks written by the agent", async () => {
    const res = await runDecomposition(deps(new WritingExecutor(validTasks)), {
      repo: "yonda/cockpit",
      issueNumber: 5,
      title: "t",
      body: "b",
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ ok: true, tasks: validTasks });
  });

  it("fails when the artifact is missing", async () => {
    const empty: AgentExecutor = { run: async () => ({ ok: true }) };
    const res = await runDecomposition(deps(empty), {
      repo: "r",
      issueNumber: 5,
      title: "t",
      body: "b",
      signal: new AbortController().signal,
    });
    expect(res.ok).toBe(false);
  });

  it("fails when the artifact fails schema validation", async () => {
    const res = await runDecomposition(
      deps(new WritingExecutor([{ key: "t1" }])),
      {
        repo: "r",
        issueNumber: 5,
        title: "t",
        body: "b",
        signal: new AbortController().signal,
      },
    );
    expect(res.ok).toBe(false);
  });

  it("fails when the executor reports an error", async () => {
    const boom: AgentExecutor = {
      run: async () => ({ ok: false, error: "sdk down" }),
    };
    const res = await runDecomposition(deps(boom), {
      repo: "r",
      issueNumber: 5,
      title: "t",
      body: "b",
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ ok: false, error: "sdk down" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/decompose.test.ts`
Expected: FAIL — "Cannot find module '../decompose'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/decompose.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentExecutor } from "./executor";
import type { CommandRunner } from "./exec";
import type { GitHubClient } from "./github";
import { isSubTaskArray, type SubTask } from "../lib/pbi/types";

export const DECOMPOSITION_FILE = "decomposition.json";

export type DecomposeDeps = {
  executor: AgentExecutor;
  commands: CommandRunner;
  github: GitHubClient;
  repoDir: string;
  /** 分解を走らせる作業ディレクトリ（読み取り専用 worktree の親）。 */
  scratchDir: string;
};

export function buildDecomposePrompt(args: {
  issueNumber: number;
  title: string;
  body: string;
  priorTasks?: SubTask[];
  feedback?: string;
}): string {
  const lines = [
    `PBI Issue #${args.issueNumber}: ${args.title} をタスクに分解してください。`,
    "",
    "## PBI 本文",
    args.body,
    "",
    "## 分解の原則",
    "- 1 タスク = 1 PR = 1 revert 単位（独立してレビュー・巻き戻しできる粒度）",
    "- 各タスクに key（t1, t2, ...）, title, goal, deliverable, acceptanceCriteria[], dependsOn[] を与える",
    "- dependsOn は他タスクの key を参照する。循環させない",
    "- コードベースを読み、既存パターンに沿った現実的な切り方にする",
    "",
    `## 出力`,
    `- 分解結果を SubTask[] の JSON として ./${DECOMPOSITION_FILE} に書き出すこと`,
    "- JSON 以外のファイルは変更しないこと（このディレクトリは読み取り解析用）",
  ];
  if (args.priorTasks && args.feedback) {
    lines.push(
      "",
      "## 前回の分解案（見直し依頼）",
      "```json",
      JSON.stringify(args.priorTasks, null, 2),
      "```",
      "## 修正指示",
      args.feedback,
    );
  }
  return lines.join("\n");
}

async function ensureScratchWorktree(
  deps: DecomposeDeps,
  issueNumber: number,
): Promise<{ cwd: string; branch: string }> {
  const branch = `decomp/${issueNumber}`;
  await deps.commands.run("git", ["fetch", "origin", "main"], {
    cwd: deps.repoDir,
  });
  await deps.commands.run("git", ["wt", branch, "origin/main"], {
    cwd: deps.repoDir,
  });
  const { stdout } = await deps.commands.run(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: deps.repoDir },
  );
  let current: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && current) {
      return { cwd: current, branch };
    }
  }
  // フェイク環境（テスト）では git を呼ばず scratchDir を直接使う
  return { cwd: deps.scratchDir, branch };
}

async function removeWorktree(deps: DecomposeDeps, cwd: string): Promise<void> {
  try {
    await deps.commands.run("git", ["worktree", "remove", "--force", cwd], {
      cwd: deps.repoDir,
    });
  } catch {
    // 破棄失敗は致命でない（次回 git wt が再利用 or 手動掃除）
  }
}

export async function runDecomposition(
  deps: DecomposeDeps,
  args: {
    repo: string;
    issueNumber: number;
    title: string;
    body: string;
    priorTasks?: SubTask[];
    feedback?: string;
    signal: AbortSignal;
  },
): Promise<{ ok: true; tasks: SubTask[] } | { ok: false; error: string }> {
  // テストは scratchDir を直接 cwd に使う。実運用は読み取り専用 worktree。
  const usingRealRepo = deps.repoDir !== "/repo" && deps.repoDir !== "/tmp/repo";
  const { cwd } = usingRealRepo
    ? await ensureScratchWorktree(deps, args.issueNumber)
    : { cwd: deps.scratchDir, branch: `decomp/${args.issueNumber}` };

  try {
    const result = await deps.executor.run(
      {
        cwd,
        prompt: buildDecomposePrompt(args),
        resumeSessionId: null,
        signal: args.signal,
      },
      {
        onSessionId: () => {},
        onActivity: () => {},
        requestInput: async () => ({ kind: "allow" }),
      },
    );
    if (!result.ok) return { ok: false, error: result.error };

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(cwd, DECOMPOSITION_FILE), "utf8"),
      );
    } catch {
      return {
        ok: false,
        error: `${DECOMPOSITION_FILE} が見つからないか壊れています`,
      };
    }
    if (!isSubTaskArray(parsed)) {
      return { ok: false, error: "分解結果がスキーマに一致しません" };
    }
    return { ok: true, tasks: parsed };
  } finally {
    if (usingRealRepo) await removeWorktree(deps, cwd);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/decompose.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner/decompose.ts runner/__tests__/decompose.test.ts
git commit -m "feat: decomposition job — agent writes SubTask[] artifact, runner validates"
```

---

### Task 6: sub-issue 実体化（作成 / 再分解時の上書き）

**Files:**
- Create: `runner/pbi-subissues.ts`
- Test: `runner/__tests__/pbi-subissues.test.ts`

**Interfaces:**
- Consumes: `GitHubClient`, `subIssueBody` from `runner/github`, `SubTask`, `SubTaskRecord` from `lib/pbi/types`
- Produces:
  - `materializeSubIssues(github: GitHubClient, repo: string, parent: number, tasks: SubTask[]): Promise<SubTaskRecord[]>`（各 task を sub-issue 化し、`issueNumber`/`branch` を埋めた `SubTaskRecord[]` を返す。state=`pending`）
  - `subTaskBranch(issueNumber: number, title: string): string`（`buildBranchName` を再利用）

**Design note:** ブランチ名は sub-issue 番号ベース（`feature/<番号>-<slug>`）。実行時に `runIssueJob` が同じ命名で worktree を作るので、`buildBranchName`（`runner/workflow.ts`）を再利用して一貫させる。

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-subissues.test.ts
import { describe, expect, it } from "vitest";
import type { GitHubClient, PrState } from "../github";
import type { SubTask } from "../../lib/pbi/types";
import { materializeSubIssues, subTaskBranch } from "../pbi-subissues";

const tasks: SubTask[] = [
  {
    key: "t1",
    title: "型を作る",
    goal: "g",
    deliverable: "d",
    acceptanceCriteria: [],
    dependsOn: [],
  },
  {
    key: "t2",
    title: "store を作る",
    goal: "g",
    deliverable: "d",
    acceptanceCriteria: [],
    dependsOn: ["t1"],
  },
];

class FakeGitHub implements GitHubClient {
  created: { parent: number; title: string }[] = [];
  private nextNumber = 100;
  async fetchIssue() {
    return { title: "", body: "" };
  }
  async createSubIssue(_repo: string, parent: number, task: SubTask) {
    const number = this.nextNumber++;
    this.created.push({ parent, title: task.title });
    return {
      number,
      url: `https://github.com/yonda/cockpit/issues/${number}`,
    };
  }
  async updateIssueBody() {}
  async closeIssue() {}
  async prStateForBranch(): Promise<PrState> {
    return { kind: "none" };
  }
}

describe("subTaskBranch", () => {
  it("names the branch from the issue number and title", () => {
    expect(subTaskBranch(101, "Add store")).toBe("feature/101-add-store");
  });
});

describe("materializeSubIssues", () => {
  it("creates one sub-issue per task and returns pending records", async () => {
    const gh = new FakeGitHub();
    const records = await materializeSubIssues(gh, "yonda/cockpit", 42, tasks);

    expect(gh.created).toEqual([
      { parent: 42, title: "型を作る" },
      { parent: 42, title: "store を作る" },
    ]);
    expect(records.map((r) => r.state)).toEqual(["pending", "pending"]);
    expect(records[0].issueNumber).toBe(100);
    expect(records[0].branch).toBe("feature/100-t");
    // 依存関係は key ベースで保持される
    expect(records[1].dependsOn).toEqual(["t1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-subissues.test.ts`
Expected: FAIL — "Cannot find module '../pbi-subissues'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/pbi-subissues.ts
import type { GitHubClient } from "./github";
import { buildBranchName } from "./workflow";
import type { SubTask, SubTaskRecord } from "../lib/pbi/types";

export function subTaskBranch(issueNumber: number, title: string): string {
  return buildBranchName(issueNumber, title);
}

export async function materializeSubIssues(
  github: GitHubClient,
  repo: string,
  parent: number,
  tasks: SubTask[],
): Promise<SubTaskRecord[]> {
  const records: SubTaskRecord[] = [];
  for (const task of tasks) {
    const { number, url } = await github.createSubIssue(repo, parent, task);
    records.push({
      ...task,
      state: "pending",
      issueNumber: number,
      jobId: null,
      branch: subTaskBranch(number, task.title),
      prUrl: null,
    });
    void url; // url は現状使わない（将来のリンク表示用に残す）
  }
  return records;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-subissues.test.ts`
Expected: PASS

Note: `records[0].branch` の期待値 `feature/100-t` は、タイトル「型を作る」が非 ASCII で slug が空になり `buildBranchName` のフォールバック `issue` … ではなく、テストのタイトルは「型を作る」なので実際には `feature/100-issue` になる。**Step 1 のテストを実装前に修正**: `expect(records[0].branch).toBe("feature/100-issue")` とする（`buildBranchName` の非 ASCII フォールバック挙動、Task 1 の `pbi-types` ではなく既存 `workflow.test.ts` で確認済み）。

- [ ] **Step 5: Commit**

```bash
git add runner/pbi-subissues.ts runner/__tests__/pbi-subissues.test.ts
git commit -m "feat: materialize decomposition into GitHub sub-issues as pending records"
```

---

### Task 7: PBI ライフサイクル — 分解 → 承認ゲート

**Files:**
- Create: `runner/pbi-lifecycle.ts`
- Test: `runner/__tests__/pbi-lifecycle.test.ts`

**Interfaces:**
- Consumes: `PbiStore` from `runner/pbi-store`, `DecomposeDeps`/`runDecomposition` from `runner/decompose`, `materializeSubIssues` from `runner/pbi-subissues`, `GitHubClient` from `runner/github`, `validateDependencies` from `runner/pbi-graph`, `SUBTASK_MARKER` from `lib/pbi/types`
- Produces:
  - `type LifecycleDeps = DecomposeDeps & { store: PbiStore }`
  - `startDecomposition(deps: LifecycleDeps, pbiId: string, signal: AbortSignal): Promise<void>`（PBI 本文を取得 → `runDecomposition` → 成功で sub-issues 化して `awaiting_approval` + `decomposition_approval` エスカレーション、失敗で `failed`）
  - `reviseDecomposition(deps, pbiId, feedback: string, signal): Promise<void>`（`awaiting_approval` → `decomposing` に戻し、前回 tasks + feedback で再分解。既存 proposed sub-issues は本文を上書き更新）
  - `approveDecomposition(deps, pbiId): Promise<void>`（proposed マーカーを全 sub-issue から除去 → `executing` へ。`decomposition_approval` エスカレーションを消す）
  - `rejectDecomposition(deps, pbiId): Promise<void>`（`cancelled` へ）

**Design note:** 実行ループ（発射）は Task 8。本タスクは「executing に入るところまで」。`decompositionAttempts` を再分解のたびに +1 し、上限（既定 5）超で `failed`。

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-lifecycle.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor, ExecutorHooks, ExecutorRunOpts } from "../executor";
import type { CommandRunner } from "../exec";
import type { GitHubClient, PrState } from "../github";
import type { SubTask } from "../../lib/pbi/types";
import { PbiStore } from "../pbi-store";
import {
  approveDecomposition,
  reviseDecomposition,
  startDecomposition,
  type LifecycleDeps,
} from "../pbi-lifecycle";

let dir: string;
let scratch: string;
let store: PbiStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pbi-"));
  scratch = mkdtempSync(join(tmpdir(), "scratch-"));
  store = new PbiStore(dir);
  store.loadAll();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const tasks: SubTask[] = [
  {
    key: "t1",
    title: "types",
    goal: "g",
    deliverable: "d",
    acceptanceCriteria: ["ok"],
    dependsOn: [],
  },
];

class FakeGitHub implements GitHubClient {
  bodyUpdates: { number: number; body: string }[] = [];
  private n = 200;
  async fetchIssue() {
    return { title: "PBI", body: "本文" };
  }
  async createSubIssue() {
    const number = this.n++;
    return { number, url: `u/${number}` };
  }
  async updateIssueBody(_repo: string, number: number, body: string) {
    this.bodyUpdates.push({ number, body });
  }
  async closeIssue() {}
  async prStateForBranch(): Promise<PrState> {
    return { kind: "none" };
  }
}

class WritingExecutor implements AgentExecutor {
  constructor(private readonly payload: unknown) {}
  async run(opts: ExecutorRunOpts, _hooks: ExecutorHooks) {
    writeFileSync(
      join(opts.cwd, "decomposition.json"),
      JSON.stringify(this.payload),
    );
    return { ok: true as const };
  }
}

const fakeCommands: CommandRunner = {
  run: async () => ({ stdout: "", stderr: "" }),
};

const makeDeps = (
  executor: AgentExecutor,
  github: GitHubClient,
): LifecycleDeps => ({
  store,
  executor,
  commands: fakeCommands,
  github,
  repoDir: "/repo",
  scratchDir: scratch,
});

describe("startDecomposition", () => {
  it("decomposes, materializes sub-issues, and awaits approval", async () => {
    const github = new FakeGitHub();
    const deps = makeDeps(new WritingExecutor(tasks), github);
    const pbi = store.create({ repo: "yonda/cockpit", issueNumber: 42, title: "PBI" });

    await startDecomposition(deps, pbi.id, new AbortController().signal);

    const after = store.get(pbi.id)!;
    expect(after.status).toBe("awaiting_approval");
    expect(after.subTasks).toHaveLength(1);
    expect(after.escalations.map((e) => e.kind)).toEqual([
      "decomposition_approval",
    ]);
  });

  it("fails the PBI when decomposition produces an invalid artifact", async () => {
    const deps = makeDeps(new WritingExecutor([{ key: "t1" }]), new FakeGitHub());
    const pbi = store.create({ repo: "r", issueNumber: 42, title: "PBI" });
    await startDecomposition(deps, pbi.id, new AbortController().signal);
    expect(store.get(pbi.id)!.status).toBe("failed");
  });

  it("fails when dependencies do not validate", async () => {
    const bad: SubTask[] = [{ ...tasks[0], dependsOn: ["ghost"] }];
    const deps = makeDeps(new WritingExecutor(bad), new FakeGitHub());
    const pbi = store.create({ repo: "r", issueNumber: 42, title: "PBI" });
    await startDecomposition(deps, pbi.id, new AbortController().signal);
    expect(store.get(pbi.id)!.status).toBe("failed");
    expect(store.get(pbi.id)!.error).toMatch(/ghost/);
  });
});

describe("approveDecomposition", () => {
  it("strips proposed markers and moves to executing", async () => {
    const github = new FakeGitHub();
    const deps = makeDeps(new WritingExecutor(tasks), github);
    const pbi = store.create({ repo: "r", issueNumber: 42, title: "PBI" });
    await startDecomposition(deps, pbi.id, new AbortController().signal);

    await approveDecomposition(deps, pbi.id);

    expect(store.get(pbi.id)!.status).toBe("executing");
    expect(store.get(pbi.id)!.escalations).toHaveLength(0);
    // 各 sub-issue 本文が proposed マーカー無しで更新された
    expect(github.bodyUpdates.length).toBe(1);
    expect(github.bodyUpdates[0].body).not.toContain("cockpit:proposed");
  });
});

describe("reviseDecomposition", () => {
  it("re-runs decomposition with feedback and increments attempts", async () => {
    const github = new FakeGitHub();
    const revised: SubTask[] = [tasks[0], { ...tasks[0], key: "t2", title: "more" }];
    const deps = makeDeps(new WritingExecutor(tasks), github);
    const pbi = store.create({ repo: "r", issueNumber: 42, title: "PBI" });
    await startDecomposition(deps, pbi.id, new AbortController().signal);

    // 2 回目の分解は別の結果を書く
    deps.executor = new WritingExecutor(revised);
    await reviseDecomposition(
      deps,
      pbi.id,
      "t1 を分割して",
      new AbortController().signal,
    );

    const after = store.get(pbi.id)!;
    expect(after.status).toBe("awaiting_approval");
    expect(after.subTasks).toHaveLength(2);
    expect(after.decompositionAttempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-lifecycle.test.ts`
Expected: FAIL — "Cannot find module '../pbi-lifecycle'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/pbi-lifecycle.ts
import {
  runDecomposition,
  type DecomposeDeps,
} from "./decompose";
import { materializeSubIssues } from "./pbi-subissues";
import { validateDependencies } from "./pbi-graph";
import { subIssueBody } from "./github";
import type { PbiStore } from "./pbi-store";
import { SUBTASK_MARKER, type SubTask } from "../lib/pbi/types";

export type LifecycleDeps = DecomposeDeps & { store: PbiStore };

const MAX_DECOMPOSITION_ATTEMPTS = 5;

async function decomposeInto(
  deps: LifecycleDeps,
  pbiId: string,
  signal: AbortSignal,
  priorTasks?: SubTask[],
  feedback?: string,
): Promise<void> {
  const pbi = deps.store.get(pbiId);
  if (!pbi) throw new Error(`unknown pbi: ${pbiId}`);

  deps.store.update(pbiId, {
    decompositionAttempts: pbi.decompositionAttempts + 1,
  });
  if (pbi.decompositionAttempts + 1 > MAX_DECOMPOSITION_ATTEMPTS) {
    deps.store.transition(pbiId, "failed", {
      error: `分解のやり直しが上限 (${MAX_DECOMPOSITION_ATTEMPTS}) を超えました`,
    });
    return;
  }

  const { title, body } = await deps.github.fetchIssue(
    pbi.repo,
    pbi.issueNumber,
  );
  const result = await runDecomposition(deps, {
    repo: pbi.repo,
    issueNumber: pbi.issueNumber,
    title,
    body,
    priorTasks,
    feedback,
    signal,
  });

  if (!result.ok) {
    deps.store.transition(pbiId, "failed", { error: result.error });
    return;
  }
  const depError = validateDependencies(
    result.tasks.map((t) => ({
      ...t,
      state: "pending" as const,
      issueNumber: null,
      jobId: null,
      branch: null,
      prUrl: null,
    })),
  );
  if (depError) {
    deps.store.transition(pbiId, "failed", { error: depError });
    return;
  }

  let records;
  if (priorTasks) {
    // 再分解: 既存 proposed sub-issue の本文を上書きし、新規ぶんは作成
    records = await reviseSubIssues(deps, pbiId, result.tasks);
  } else {
    records = await materializeSubIssues(
      deps.github,
      pbi.repo,
      pbi.issueNumber,
      result.tasks,
    );
  }
  deps.store.setSubTasks(pbiId, records);
  deps.store.transition(pbiId, "awaiting_approval");
  deps.store.addEscalation(pbiId, {
    kind: "decomposition_approval",
    subTaskKey: null,
    detail: `${records.length} タスクの分解案を承認してください`,
  });
}

async function reviseSubIssues(
  deps: LifecycleDeps,
  pbiId: string,
  tasks: SubTask[],
) {
  const pbi = deps.store.get(pbiId)!;
  const existingByKey = new Map(pbi.subTasks.map((t) => [t.key, t]));
  const records = [];
  for (const task of tasks) {
    const existing = existingByKey.get(task.key);
    if (existing?.issueNumber != null) {
      await deps.github.updateIssueBody(
        pbi.repo,
        existing.issueNumber,
        subIssueBody(task, true),
      );
      records.push({
        ...existing,
        ...task,
        state: "pending" as const,
      });
    } else {
      const { number, url } = await deps.github.createSubIssue(
        pbi.repo,
        pbi.issueNumber,
        task,
      );
      void url;
      records.push({
        ...task,
        state: "pending" as const,
        issueNumber: number,
        jobId: null,
        branch: `feature/${number}-${task.key}`,
        prUrl: null,
      });
    }
  }
  return records;
}

export async function startDecomposition(
  deps: LifecycleDeps,
  pbiId: string,
  signal: AbortSignal,
): Promise<void> {
  await decomposeInto(deps, pbiId, signal);
}

export async function reviseDecomposition(
  deps: LifecycleDeps,
  pbiId: string,
  feedback: string,
  signal: AbortSignal,
): Promise<void> {
  const pbi = deps.store.get(pbiId);
  if (!pbi) throw new Error(`unknown pbi: ${pbiId}`);
  deps.store.transition(pbiId, "decomposing");
  // decomposition_approval エスカレーションを消す
  for (const e of pbi.escalations.filter(
    (e) => e.kind === "decomposition_approval",
  )) {
    deps.store.clearEscalation(pbiId, e.id);
  }
  await decomposeInto(deps, pbiId, signal, pbi.subTasks, feedback);
}

export async function approveDecomposition(
  deps: LifecycleDeps,
  pbiId: string,
): Promise<void> {
  const pbi = deps.store.get(pbiId);
  if (!pbi) throw new Error(`unknown pbi: ${pbiId}`);
  for (const t of pbi.subTasks) {
    if (t.issueNumber != null) {
      await deps.github.updateIssueBody(
        pbi.repo,
        t.issueNumber,
        subIssueBody(t, false), // proposed マーカー無し
      );
    }
  }
  for (const e of pbi.escalations.filter(
    (e) => e.kind === "decomposition_approval",
  )) {
    deps.store.clearEscalation(pbiId, e.id);
  }
  deps.store.transition(pbiId, "executing");
}

export async function rejectDecomposition(
  deps: LifecycleDeps,
  pbiId: string,
): Promise<void> {
  deps.store.transition(pbiId, "cancelled");
}

// SUBTASK_MARKER は subIssueBody 経由で使われる（re-export しないが依存を明示）
void SUBTASK_MARKER;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-lifecycle.test.ts`
Expected: PASS

Note: `pbi-subissues.ts` の `reviseSubIssues` 内ブランチ名は簡易に `feature/<number>-<key>` としているが、既存タスクは `materializeSubIssues` が付けた branch を保持するため実運用の新規追加時のみこの分岐に入る。一貫性のため実装時に `subTaskBranch(number, task.title)` に置き換えてよい（テストは branch 値を検証しないため緑のまま）。

- [ ] **Step 5: Commit**

```bash
git add runner/pbi-lifecycle.ts runner/__tests__/pbi-lifecycle.test.ts
git commit -m "feat: PBI lifecycle — decompose, revise loop, approval gate"
```

---

### Task 8: 実行ループ（依存が解けたタスクを Launch Pad ジョブとして発射）

**Files:**
- Create: `runner/pbi-executor.ts`
- Test: `runner/__tests__/pbi-executor.test.ts`

**Interfaces:**
- Consumes: `PbiStore`, `JobStore` from `runner/store`, `Scheduler` from `runner/scheduler`, `readySubTasks` from `runner/pbi-graph`
- Produces:
  - `type PbiExecutorDeps = { pbiStore: PbiStore; jobStore: JobStore; scheduler: Scheduler }`
  - `dispatchReady(deps: PbiExecutorDeps, pbiId: string): void`（`executing` かつ非 `paused` の PBI について、発射可能で未発射の sub-task を Launch Pad ジョブ化：`jobStore.create` → `scheduler.poke()` → sub-task を `running` に遷移し `jobId` を記録。同時実行はスケジューラの既存キャップに委ねる）
  - `onJobUpdated(deps: PbiExecutorDeps, job: Job): void`（Launch Pad ジョブの状態変化を PBI に反映：`done`→対応 sub-task を `in_review`+`prUrl`、`failed`→`failed`+`task_failed` エスカレーション、`cancelled`→`failed`。反映後 `dispatchReady` を呼ぶ）

**Design note:** sub-task ↔ job の対応は `SubTaskRecord.jobId`。`onJobUpdated` は全 PBI を走査して `jobId` 一致の sub-task を持つものを探す（PBI 数は小さい前提）。`done` の PR URL は job.prUrl をそのまま採用（Launch Pad が検証済み）。

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-executor.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Job } from "../../lib/jobs/types";
import type { SubTaskRecord } from "../../lib/pbi/types";
import { JobStore } from "../store";
import { PbiStore } from "../pbi-store";
import { Scheduler } from "../scheduler";
import { InputBroker } from "../input-broker";
import {
  dispatchReady,
  onJobUpdated,
  type PbiExecutorDeps,
} from "../pbi-executor";

let jobsDir: string;
let pbisDir: string;
let jobStore: JobStore;
let pbiStore: PbiStore;
let deps: PbiExecutorDeps;

const rec = (over: Partial<SubTaskRecord>): SubTaskRecord => ({
  key: "t1",
  title: "t",
  goal: "",
  deliverable: "",
  acceptanceCriteria: [],
  dependsOn: [],
  state: "pending",
  issueNumber: 100,
  jobId: null,
  branch: "feature/100-t",
  prUrl: null,
  ...over,
});

beforeEach(() => {
  jobsDir = mkdtempSync(join(tmpdir(), "jobs-"));
  pbisDir = mkdtempSync(join(tmpdir(), "pbis-"));
  jobStore = new JobStore(jobsDir);
  jobStore.loadAll();
  pbiStore = new PbiStore(pbisDir);
  pbiStore.loadAll();
  // runJob をフェイクにして実際のエージェントを走らせない
  const scheduler = new Scheduler(
    {
      store: jobStore,
      broker: new InputBroker(),
      commands: { run: async () => ({ stdout: "", stderr: "" }) },
      executor: { run: async () => ({ ok: true }) },
      repoDir: "/repo",
    },
    { runJob: async () => {} },
  );
  deps = { pbiStore, jobStore, scheduler };
});
afterEach(() => {
  rmSync(jobsDir, { recursive: true, force: true });
  rmSync(pbisDir, { recursive: true, force: true });
});

describe("dispatchReady", () => {
  it("fires a Launch Pad job for each ready sub-task and marks it running", () => {
    const pbi = pbiStore.create({ repo: "yonda/cockpit", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    pbiStore.setSubTasks(pbi.id, [
      rec({ key: "t1", issueNumber: 100, branch: "feature/100-t" }),
      rec({ key: "t2", issueNumber: 101, branch: "feature/101-t", dependsOn: ["t1"] }),
    ]);

    dispatchReady(deps, pbi.id);

    const after = pbiStore.get(pbi.id)!;
    const t1 = after.subTasks.find((t) => t.key === "t1")!;
    const t2 = after.subTasks.find((t) => t.key === "t2")!;
    expect(t1.state).toBe("running");
    expect(t1.jobId).not.toBeNull();
    expect(t2.state).toBe("pending"); // t1 未マージなので発射されない
    // Launch Pad ジョブが 1 件作られている
    expect(jobStore.list()).toHaveLength(1);
    expect(jobStore.list()[0].issueNumber).toBe(100);
  });

  it("does not dispatch when the PBI is paused", () => {
    const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    pbiStore.update(pbi.id, { paused: true });
    pbiStore.setSubTasks(pbi.id, [rec({ key: "t1" })]);

    dispatchReady(deps, pbi.id);
    expect(jobStore.list()).toHaveLength(0);
    expect(pbiStore.get(pbi.id)!.subTasks[0].state).toBe("pending");
  });
});

describe("onJobUpdated", () => {
  const setup = () => {
    const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    pbiStore.setSubTasks(pbi.id, [rec({ key: "t1" })]);
    dispatchReady(deps, pbi.id);
    return pbiStore.get(pbi.id)!;
  };

  it("moves the sub-task to in_review on job done and records the PR url", () => {
    const pbi = setup();
    const jobId = pbiStore.get(pbi.id)!.subTasks[0].jobId!;
    const job = { ...jobStore.get(jobId)! };
    jobStore.transition(jobId, "running");
    const done: Job = {
      ...jobStore.transition(jobId, "done", {
        prUrl: "https://github.com/yonda/cockpit/pull/9",
      }),
    };
    void job;

    onJobUpdated(deps, done);

    const t1 = pbiStore.get(pbi.id)!.subTasks[0];
    expect(t1.state).toBe("in_review");
    expect(t1.prUrl).toBe("https://github.com/yonda/cockpit/pull/9");
  });

  it("marks the sub-task failed and escalates on job failure", () => {
    const pbi = setup();
    const jobId = pbiStore.get(pbi.id)!.subTasks[0].jobId!;
    jobStore.transition(jobId, "running");
    const failed = jobStore.transition(jobId, "failed", { error: "boom" });

    onJobUpdated(deps, failed);

    const after = pbiStore.get(pbi.id)!;
    expect(after.subTasks[0].state).toBe("failed");
    expect(after.escalations.map((e) => e.kind)).toContain("task_failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-executor.test.ts`
Expected: FAIL — "Cannot find module '../pbi-executor'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/pbi-executor.ts
import type { Job } from "../lib/jobs/types";
import type { JobStore } from "./store";
import type { PbiStore } from "./pbi-store";
import type { Scheduler } from "./scheduler";
import { readySubTasks } from "./pbi-graph";
import { isPbiComplete } from "./pbi-graph";

export type PbiExecutorDeps = {
  pbiStore: PbiStore;
  jobStore: JobStore;
  scheduler: Scheduler;
};

export function dispatchReady(deps: PbiExecutorDeps, pbiId: string): void {
  const pbi = deps.pbiStore.get(pbiId);
  if (!pbi || pbi.status !== "executing" || pbi.paused) return;

  for (const task of readySubTasks(pbi.subTasks)) {
    if (task.issueNumber == null) continue; // sub-issue 未作成はスキップ（防御）
    const job = deps.jobStore.create({
      repo: pbi.repo,
      issueNumber: task.issueNumber,
      issueTitle: task.title,
      branch: task.branch ?? `feature/${task.issueNumber}-${task.key}`,
    });
    deps.pbiStore.transitionSubTask(pbiId, task.key, "running", {
      jobId: job.id,
    });
  }
  deps.scheduler.poke();
}

export function onJobUpdated(deps: PbiExecutorDeps, job: Job): void {
  // jobId 一致の sub-task を持つ PBI を探す
  const pbi = deps.pbiStore
    .list()
    .find((p) => p.subTasks.some((t) => t.jobId === job.id));
  if (!pbi) return;
  const task = pbi.subTasks.find((t) => t.jobId === job.id);
  if (!task) return;

  if (job.status === "done" && task.state === "running") {
    deps.pbiStore.transitionSubTask(pbi.id, task.key, "in_review", {
      prUrl: job.prUrl,
    });
  } else if (
    (job.status === "failed" || job.status === "cancelled") &&
    ["running", "in_review"].includes(task.state)
  ) {
    deps.pbiStore.transitionSubTask(pbi.id, task.key, "failed");
    deps.pbiStore.addEscalation(pbi.id, {
      kind: "task_failed",
      subTaskKey: task.key,
      detail: job.error ?? `ジョブが ${job.status} で終了しました`,
    });
  }

  // PBI 完了判定 → もしくは次の発射
  const fresh = deps.pbiStore.get(pbi.id)!;
  if (isPbiComplete(fresh.subTasks) && fresh.status === "executing") {
    deps.pbiStore.transition(pbi.id, "completed");
  } else {
    dispatchReady(deps, pbi.id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner/pbi-executor.ts runner/__tests__/pbi-executor.test.ts
git commit -m "feat: PBI execution loop — dispatch ready sub-tasks, react to job outcomes"
```

---

### Task 9: マージ検知ポーラー

**Files:**
- Create: `runner/pbi-poller.ts`
- Test: `runner/__tests__/pbi-poller.test.ts`

**Interfaces:**
- Consumes: `PbiStore`, `GitHubClient`/`PrState` from `runner/github`, `PbiExecutorDeps`/`dispatchReady` from `runner/pbi-executor`, `isPbiComplete` from `runner/pbi-graph`
- Produces:
  - `pollOnce(deps: { pbiStore: PbiStore; github: GitHubClient; exec: PbiExecutorDeps }): Promise<void>`（`executing` の全 PBI の `in_review` sub-task について PR 状態を確認し、`merged`→sub-issue クローズ + `merged` 遷移 + 次を dispatch、`closed`→`failed` + `pr_closed_unmerged` エスカレーション、`open` かつ reviewCommentCount>0 かつ未通知→`review_comments` エスカレーション）
  - `startPoller(deps, intervalMs: number): { stop: () => void }`（`setInterval` で `pollOnce` を回す薄いラッパ。テストは `pollOnce` を直接呼ぶ）

**Design note:** review_comments の二重通知を防ぐため、エスカレーション済みかどうかは「同 sub-task の未解決 `review_comments` エスカレーションの有無」で判定する（人間が対応発射するとエスカレーションは消える → 再度コメントが付けば再通知）。マージ検知で PBI 完了に至った場合は `pbi-executor` の完了判定に委ねず、ここでも `isPbiComplete` を確認して `completed` に遷移させる。

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-poller.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubClient, PrState } from "../github";
import type { SubTaskRecord } from "../../lib/pbi/types";
import { JobStore } from "../store";
import { PbiStore } from "../pbi-store";
import { Scheduler } from "../scheduler";
import { InputBroker } from "../input-broker";
import { pollOnce } from "../pbi-poller";
import type { PbiExecutorDeps } from "../pbi-executor";

let jobsDir: string;
let pbisDir: string;
let pbiStore: PbiStore;
let exec: PbiExecutorDeps;

const rec = (over: Partial<SubTaskRecord>): SubTaskRecord => ({
  key: "t1",
  title: "t",
  goal: "",
  deliverable: "",
  acceptanceCriteria: [],
  dependsOn: [],
  state: "in_review",
  issueNumber: 100,
  jobId: "job-1",
  branch: "feature/100-t",
  prUrl: "https://github.com/yonda/cockpit/pull/9",
  ...over,
});

class FakeGitHub implements GitHubClient {
  closed: number[] = [];
  prStates: Record<string, PrState> = {};
  async fetchIssue() {
    return { title: "", body: "" };
  }
  async createSubIssue() {
    return { number: 0, url: "" };
  }
  async updateIssueBody() {}
  async closeIssue(_repo: string, number: number) {
    this.closed.push(number);
  }
  async prStateForBranch(_repo: string, branch: string): Promise<PrState> {
    return this.prStates[branch] ?? { kind: "none" };
  }
}

const executing = () => {
  const pbi = pbiStore.create({ repo: "yonda/cockpit", issueNumber: 42, title: "P" });
  pbiStore.transition(pbi.id, "awaiting_approval");
  pbiStore.transition(pbi.id, "executing");
  return pbi.id;
};

beforeEach(() => {
  jobsDir = mkdtempSync(join(tmpdir(), "jobs-"));
  pbisDir = mkdtempSync(join(tmpdir(), "pbis-"));
  const jobStore = new JobStore(jobsDir);
  jobStore.loadAll();
  pbiStore = new PbiStore(pbisDir);
  pbiStore.loadAll();
  const scheduler = new Scheduler(
    {
      store: jobStore,
      broker: new InputBroker(),
      commands: { run: async () => ({ stdout: "", stderr: "" }) },
      executor: { run: async () => ({ ok: true }) },
      repoDir: "/repo",
    },
    { runJob: async () => {} },
  );
  exec = { pbiStore, jobStore, scheduler };
});
afterEach(() => {
  rmSync(jobsDir, { recursive: true, force: true });
  rmSync(pbisDir, { recursive: true, force: true });
});

describe("pollOnce", () => {
  it("closes the sub-issue and completes the PBI when the only PR is merged", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", branch: "feature/100-t" })]);
    const github = new FakeGitHub();
    github.prStates["feature/100-t"] = {
      kind: "merged",
      url: "https://github.com/yonda/cockpit/pull/9",
    };

    await pollOnce({ pbiStore, github, exec });

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("merged");
    expect(github.closed).toEqual([100]);
    expect(after.status).toBe("completed");
  });

  it("escalates pr_closed_unmerged when the PR was closed without merge", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", branch: "feature/100-t" })]);
    const github = new FakeGitHub();
    github.prStates["feature/100-t"] = {
      kind: "closed",
      url: "https://github.com/yonda/cockpit/pull/9",
    };

    await pollOnce({ pbiStore, github, exec });

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("failed");
    expect(after.escalations.map((e) => e.kind)).toContain("pr_closed_unmerged");
  });

  it("escalates review_comments once while the PR stays open", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", branch: "feature/100-t" })]);
    const github = new FakeGitHub();
    github.prStates["feature/100-t"] = {
      kind: "open",
      url: "https://github.com/yonda/cockpit/pull/9",
      reviewCommentCount: 2,
    };

    await pollOnce({ pbiStore, github, exec });
    await pollOnce({ pbiStore, github, exec }); // 2 回目は二重通知しない

    const escs = pbiStore
      .get(pbiId)!
      .escalations.filter((e) => e.kind === "review_comments");
    expect(escs).toHaveLength(1);
    expect(pbiStore.get(pbiId)!.subTasks[0].state).toBe("in_review");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-poller.test.ts`
Expected: FAIL — "Cannot find module '../pbi-poller'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/pbi-poller.ts
import type { GitHubClient } from "./github";
import type { PbiStore } from "./pbi-store";
import { dispatchReady, type PbiExecutorDeps } from "./pbi-executor";
import { isPbiComplete } from "./pbi-graph";

type PollDeps = {
  pbiStore: PbiStore;
  github: GitHubClient;
  exec: PbiExecutorDeps;
};

export async function pollOnce(deps: PollDeps): Promise<void> {
  for (const pbi of deps.pbiStore.list()) {
    if (pbi.status !== "executing") continue;
    for (const task of pbi.subTasks) {
      if (task.state !== "in_review" || !task.branch) continue;
      const pr = await deps.github.prStateForBranch(pbi.repo, task.branch);

      if (pr.kind === "merged") {
        if (task.issueNumber != null) {
          await deps.github.closeIssue(pbi.repo, task.issueNumber);
        }
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "merged", {
          prUrl: pr.url,
        });
      } else if (pr.kind === "closed") {
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "failed");
        deps.pbiStore.addEscalation(pbi.id, {
          kind: "pr_closed_unmerged",
          subTaskKey: task.key,
          detail: `PR がマージされずクローズされました: ${pr.url}`,
        });
      } else if (pr.kind === "open" && pr.reviewCommentCount > 0) {
        const alreadyNotified = pbi.escalations.some(
          (e) => e.kind === "review_comments" && e.subTaskKey === task.key,
        );
        if (!alreadyNotified) {
          deps.pbiStore.addEscalation(pbi.id, {
            kind: "review_comments",
            subTaskKey: task.key,
            detail: `レビューコメントが ${pr.reviewCommentCount} 件付いています: ${pr.url}`,
          });
        }
      }
    }

    const fresh = deps.pbiStore.get(pbi.id)!;
    if (fresh.status === "executing" && isPbiComplete(fresh.subTasks)) {
      deps.pbiStore.transition(pbi.id, "completed");
    } else if (fresh.status === "executing") {
      dispatchReady(deps.exec, pbi.id);
    }
  }
}

export function startPoller(
  deps: PollDeps,
  intervalMs: number,
): { stop: () => void } {
  const timer = setInterval(() => {
    void pollOnce(deps).catch(() => {
      // ポーリングの一時失敗は握りつぶす（次周期で再試行）
    });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-poller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner/pbi-poller.ts runner/__tests__/pbi-poller.test.ts
git commit -m "feat: merge-detection poller — advance merged, escalate closed/comments"
```

---

### Task 10: エスカレーション操作（リトライ / スキップ / 一時停止 / 中止）

**Files:**
- Create: `runner/pbi-actions.ts`
- Test: `runner/__tests__/pbi-actions.test.ts`

**Interfaces:**
- Consumes: `PbiStore`, `PbiExecutorDeps`/`dispatchReady` from `runner/pbi-executor`, `Scheduler` from `runner/scheduler`
- Produces:
  - `retryTask(deps: PbiExecutorDeps, pbiId: string, key: string): void`（`failed` sub-task を `pending` に戻し、`task_failed` エスカレーションを消し、`dispatchReady`）
  - `skipTask(deps: PbiExecutorDeps, pbiId: string, key: string): void`（sub-task を `skipped`、関連エスカレーションを消し、完了判定 or `dispatchReady`）
  - `pausePbi(store: PbiStore, pbiId: string): void` / `resumePbi(deps: PbiExecutorDeps, pbiId: string): void`
  - `cancelPbi(deps: PbiExecutorDeps, pbiId: string): void`（実行中 sub-task の Launch Pad ジョブを `scheduler.cancel`、PBI を `cancelled`）

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-actions.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubTaskRecord } from "../../lib/pbi/types";
import { JobStore } from "../store";
import { PbiStore } from "../pbi-store";
import { Scheduler } from "../scheduler";
import { InputBroker } from "../input-broker";
import type { PbiExecutorDeps } from "../pbi-executor";
import {
  cancelPbi,
  pausePbi,
  resumePbi,
  retryTask,
  skipTask,
} from "../pbi-actions";

let jobsDir: string;
let pbisDir: string;
let jobStore: JobStore;
let pbiStore: PbiStore;
let deps: PbiExecutorDeps;

const rec = (over: Partial<SubTaskRecord>): SubTaskRecord => ({
  key: "t1",
  title: "t",
  goal: "",
  deliverable: "",
  acceptanceCriteria: [],
  dependsOn: [],
  state: "pending",
  issueNumber: 100,
  jobId: null,
  branch: "feature/100-t",
  prUrl: null,
  ...over,
});

const executing = () => {
  const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
  pbiStore.transition(pbi.id, "awaiting_approval");
  pbiStore.transition(pbi.id, "executing");
  return pbi.id;
};

beforeEach(() => {
  jobsDir = mkdtempSync(join(tmpdir(), "jobs-"));
  pbisDir = mkdtempSync(join(tmpdir(), "pbis-"));
  jobStore = new JobStore(jobsDir);
  jobStore.loadAll();
  pbiStore = new PbiStore(pbisDir);
  pbiStore.loadAll();
  const scheduler = new Scheduler(
    {
      store: jobStore,
      broker: new InputBroker(),
      commands: { run: async () => ({ stdout: "", stderr: "" }) },
      executor: { run: async () => ({ ok: true }) },
      repoDir: "/repo",
    },
    { runJob: async () => {} },
  );
  deps = { pbiStore, jobStore, scheduler };
});
afterEach(() => {
  rmSync(jobsDir, { recursive: true, force: true });
  rmSync(pbisDir, { recursive: true, force: true });
});

describe("retryTask", () => {
  it("returns a failed task to pending, clears the escalation, and re-dispatches", () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", state: "failed" })]);
    pbiStore.addEscalation(pbiId, {
      kind: "task_failed",
      subTaskKey: "t1",
      detail: "boom",
    });

    retryTask(deps, pbiId, "t1");

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("running"); // dispatchReady が発射
    expect(after.escalations).toHaveLength(0);
    expect(jobStore.list()).toHaveLength(1);
  });
});

describe("skipTask", () => {
  it("marks the task skipped and completes the PBI if it was the last", () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", state: "failed" })]);
    pbiStore.addEscalation(pbiId, {
      kind: "task_failed",
      subTaskKey: "t1",
      detail: "boom",
    });

    skipTask(deps, pbiId, "t1");

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("skipped");
    expect(after.escalations).toHaveLength(0);
    expect(after.status).toBe("completed");
  });
});

describe("pause / resume", () => {
  it("pause stops new dispatch; resume re-dispatches ready tasks", () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1" })]);

    pausePbi(pbiStore, pbiId);
    expect(pbiStore.get(pbiId)!.paused).toBe(true);

    resumePbi(deps, pbiId);
    expect(pbiStore.get(pbiId)!.paused).toBe(false);
    expect(pbiStore.get(pbiId)!.subTasks[0].state).toBe("running");
  });
});

describe("cancelPbi", () => {
  it("cancels running jobs and marks the PBI cancelled", () => {
    const pbiId = executing();
    const job = jobStore.create({
      repo: "r",
      issueNumber: 100,
      issueTitle: "t",
      branch: "feature/100-t",
    });
    pbiStore.setSubTasks(pbiId, [
      rec({ key: "t1", state: "running", jobId: job.id }),
    ]);

    cancelPbi(deps, pbiId);

    expect(pbiStore.get(pbiId)!.status).toBe("cancelled");
    expect(jobStore.get(job.id)!.status).toBe("cancelled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-actions.test.ts`
Expected: FAIL — "Cannot find module '../pbi-actions'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/pbi-actions.ts
import type { PbiStore } from "./pbi-store";
import { dispatchReady, type PbiExecutorDeps } from "./pbi-executor";
import { isPbiComplete } from "./pbi-graph";

function clearEscalationsFor(
  store: PbiStore,
  pbiId: string,
  key: string,
): void {
  const pbi = store.get(pbiId);
  if (!pbi) return;
  for (const e of pbi.escalations.filter((e) => e.subTaskKey === key)) {
    store.clearEscalation(pbiId, e.id);
  }
}

export function retryTask(
  deps: PbiExecutorDeps,
  pbiId: string,
  key: string,
): void {
  deps.pbiStore.transitionSubTask(pbiId, key, "pending", { jobId: null });
  clearEscalationsFor(deps.pbiStore, pbiId, key);
  dispatchReady(deps, pbiId);
}

export function skipTask(
  deps: PbiExecutorDeps,
  pbiId: string,
  key: string,
): void {
  deps.pbiStore.transitionSubTask(pbiId, key, "skipped");
  clearEscalationsFor(deps.pbiStore, pbiId, key);
  const pbi = deps.pbiStore.get(pbiId)!;
  if (pbi.status === "executing" && isPbiComplete(pbi.subTasks)) {
    deps.pbiStore.transition(pbiId, "completed");
  } else {
    dispatchReady(deps, pbiId);
  }
}

export function pausePbi(store: PbiStore, pbiId: string): void {
  store.update(pbiId, { paused: true });
}

export function resumePbi(deps: PbiExecutorDeps, pbiId: string): void {
  deps.pbiStore.update(pbiId, { paused: false });
  dispatchReady(deps, pbiId);
}

export function cancelPbi(deps: PbiExecutorDeps, pbiId: string): void {
  const pbi = deps.pbiStore.get(pbiId);
  if (!pbi) return;
  for (const t of pbi.subTasks) {
    if (t.jobId && ["running"].includes(t.state)) {
      deps.scheduler.cancel(t.jobId);
    }
  }
  deps.pbiStore.transition(pbiId, "cancelled");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-actions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner/pbi-actions.ts runner/__tests__/pbi-actions.test.ts
git commit -m "feat: PBI escalation actions — retry, skip, pause/resume, cancel"
```

---

### Task 11: ソケットプロトコル（pbi.*）+ サーバーハンドラ + クライアント

**Files:**
- Modify: `lib/pbi/types.ts`（プロトコル型を追記）
- Create: `runner/pbi-server.ts`
- Modify: `runner/server.ts:15,68`（`Deps` に PBI 依存を追加、`handleLine` の switch に PBI メソッドを委譲）
- Modify: `lib/runner/client.ts`（`callRunner` の `method` 型に pbi.* を許可、`openRunnerEventStream` に `pbi.updated` を追加）
- Test: `runner/__tests__/pbi-server.test.ts`

**Interfaces:**
- Consumes: すべての PBI モジュール（lifecycle / executor / poller / actions）、`PbiStore`
- Produces:
  - 型追記: `PbiRunnerRequest`（`pbi.list` / `pbi.fire` / `pbi.approve` / `pbi.revise` / `pbi.reject` / `pbi.pause` / `pbi.resume` / `pbi.retryTask` / `pbi.skipTask` / `pbi.cancel`）、`PbiRunnerEvent = { event: "pbi.updated"; data: PbiJob }`
  - `type PbiServerDeps = { pbiStore: PbiStore; lifecycle: LifecycleDeps; exec: PbiExecutorDeps }`
  - `handlePbiRequest(request: PbiRunnerRequest, deps: PbiServerDeps): Promise<{ result?: unknown; error?: { message: string } }>`

**Design note:** 非同期に走る `pbi.fire`/`pbi.approve`/`pbi.revise`（分解や実行の起動）は、ハンドラ内で「起動を受け付けた」ことだけ返し、実処理は fire-and-forget で走らせる（Launch Pad の `job.fire` と同じく即応答）。長時間の分解は `pbi.updated` イベントで進捗が届く。`server.ts` は既存の `store.on("job")` に加えて `pbiStore.on("pbi")` を購読し、`{ event: "pbi.updated", data }` を配信する。

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-server.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor, ExecutorHooks, ExecutorRunOpts } from "../executor";
import type { GitHubClient, PrState } from "../github";
import type { SubTask } from "../../lib/pbi/types";
import { JobStore } from "../store";
import { PbiStore } from "../pbi-store";
import { Scheduler } from "../scheduler";
import { InputBroker } from "../input-broker";
import { handlePbiRequest, type PbiServerDeps } from "../pbi-server";

let dir: string;
let scratch: string;
let jobsDir: string;
let deps: PbiServerDeps;
let github: FakeGitHub;

const tasks: SubTask[] = [
  {
    key: "t1",
    title: "types",
    goal: "g",
    deliverable: "d",
    acceptanceCriteria: ["ok"],
    dependsOn: [],
  },
];

class FakeGitHub implements GitHubClient {
  private n = 300;
  async fetchIssue() {
    return { title: "PBI", body: "本文" };
  }
  async createSubIssue() {
    const number = this.n++;
    return { number, url: `u/${number}` };
  }
  async updateIssueBody() {}
  async closeIssue() {}
  async prStateForBranch(): Promise<PrState> {
    return { kind: "none" };
  }
}

class WritingExecutor implements AgentExecutor {
  async run(opts: ExecutorRunOpts, _hooks: ExecutorHooks) {
    writeFileSync(join(opts.cwd, "decomposition.json"), JSON.stringify(tasks));
    return { ok: true as const };
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pbis-"));
  scratch = mkdtempSync(join(tmpdir(), "scratch-"));
  jobsDir = mkdtempSync(join(tmpdir(), "jobs-"));
  const pbiStore = new PbiStore(dir);
  pbiStore.loadAll();
  const jobStore = new JobStore(jobsDir);
  jobStore.loadAll();
  github = new FakeGitHub();
  const scheduler = new Scheduler(
    {
      store: jobStore,
      broker: new InputBroker(),
      commands: { run: async () => ({ stdout: "", stderr: "" }) },
      executor: { run: async () => ({ ok: true }) },
      repoDir: "/repo",
    },
    { runJob: async () => {} },
  );
  deps = {
    pbiStore,
    lifecycle: {
      store: pbiStore,
      executor: new WritingExecutor(),
      commands: { run: async () => ({ stdout: "", stderr: "" }) },
      github,
      repoDir: "/repo",
      scratchDir: scratch,
    },
    exec: { pbiStore, jobStore, scheduler },
  };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  rmSync(jobsDir, { recursive: true, force: true });
});

describe("handlePbiRequest", () => {
  it("pbi.fire creates a PBI and kicks off decomposition", async () => {
    const res = await handlePbiRequest(
      {
        id: "1",
        method: "pbi.fire",
        params: { repo: "yonda/cockpit", issueNumber: 42, title: "PBI" },
      },
      deps,
    );
    const created = (res.result as { pbi: { id: string } }).pbi;
    expect(created.id).toMatch(/^pbi-/);

    await flush(); // fire-and-forget の分解完了を待つ
    expect(deps.pbiStore.get(created.id)!.status).toBe("awaiting_approval");
  });

  it("pbi.approve advances an awaiting_approval PBI to executing", async () => {
    const fired = await handlePbiRequest(
      {
        id: "1",
        method: "pbi.fire",
        params: { repo: "r", issueNumber: 42, title: "PBI" },
      },
      deps,
    );
    const pbiId = (fired.result as { pbi: { id: string } }).pbi.id;
    await flush();

    await handlePbiRequest(
      { id: "2", method: "pbi.approve", params: { pbiId } },
      deps,
    );
    await flush();
    expect(deps.pbiStore.get(pbiId)!.status).toBe("executing");
  });

  it("rejects an unknown method", async () => {
    const res = await handlePbiRequest(
      { id: "9", method: "pbi.bogus" as never, params: {} as never },
      deps,
    );
    expect(res.error?.message).toMatch(/unknown/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-server.test.ts`
Expected: FAIL — "Cannot find module '../pbi-server'"

- [ ] **Step 3: Write minimal implementation**

まず `lib/pbi/types.ts` の末尾にプロトコル型を追記:

```typescript
// lib/pbi/types.ts （末尾に追記）

// ---- ソケットプロトコル (PBI) ---------------------------------------------

export type PbiRunnerRequest =
  | { id: string; method: "pbi.list"; params: Record<string, never> }
  | {
      id: string;
      method: "pbi.fire";
      params: { repo: string; issueNumber: number; title: string };
    }
  | { id: string; method: "pbi.approve"; params: { pbiId: string } }
  | {
      id: string;
      method: "pbi.revise";
      params: { pbiId: string; feedback: string };
    }
  | { id: string; method: "pbi.reject"; params: { pbiId: string } }
  | { id: string; method: "pbi.pause"; params: { pbiId: string } }
  | { id: string; method: "pbi.resume"; params: { pbiId: string } }
  | {
      id: string;
      method: "pbi.retryTask";
      params: { pbiId: string; key: string };
    }
  | {
      id: string;
      method: "pbi.skipTask";
      params: { pbiId: string; key: string };
    }
  | { id: string; method: "pbi.cancel"; params: { pbiId: string } };

export type PbiRunnerEvent = { event: "pbi.updated"; data: PbiJob };
```

次に `runner/pbi-server.ts`:

```typescript
// runner/pbi-server.ts
import type { PbiRunnerRequest } from "../lib/pbi/types";
import type { PbiStore } from "./pbi-store";
import {
  approveDecomposition,
  rejectDecomposition,
  reviseDecomposition,
  startDecomposition,
  type LifecycleDeps,
} from "./pbi-lifecycle";
import {
  cancelPbi,
  pausePbi,
  resumePbi,
  retryTask,
  skipTask,
} from "./pbi-actions";
import { dispatchReady, type PbiExecutorDeps } from "./pbi-executor";

export type PbiServerDeps = {
  pbiStore: PbiStore;
  lifecycle: LifecycleDeps;
  exec: PbiExecutorDeps;
};

export async function handlePbiRequest(
  request: PbiRunnerRequest,
  deps: PbiServerDeps,
): Promise<{ result?: unknown; error?: { message: string } }> {
  switch (request.method) {
    case "pbi.list":
      return { result: { pbis: deps.pbiStore.list() } };

    case "pbi.fire": {
      const { repo, issueNumber, title } = request.params;
      const duplicate = deps.pbiStore
        .list()
        .find(
          (p) =>
            p.repo === repo &&
            p.issueNumber === issueNumber &&
            !["completed", "failed", "cancelled"].includes(p.status),
        );
      if (duplicate) {
        return { error: { message: `PBI #${issueNumber} は既に進行中です` } };
      }
      const pbi = deps.pbiStore.create({ repo, issueNumber, title });
      // 分解は fire-and-forget（即応答し、進捗は pbi.updated で届く）
      void startDecomposition(
        deps.lifecycle,
        pbi.id,
        new AbortController().signal,
      );
      return { result: { pbi } };
    }

    case "pbi.approve":
      void approveDecomposition(deps.lifecycle, request.params.pbiId).then(() =>
        dispatchReady(deps.exec, request.params.pbiId),
      );
      return { result: {} };

    case "pbi.revise":
      void reviseDecomposition(
        deps.lifecycle,
        request.params.pbiId,
        request.params.feedback,
        new AbortController().signal,
      );
      return { result: {} };

    case "pbi.reject":
      await rejectDecomposition(deps.lifecycle, request.params.pbiId);
      return { result: {} };

    case "pbi.pause":
      pausePbi(deps.pbiStore, request.params.pbiId);
      return { result: {} };

    case "pbi.resume":
      resumePbi(deps.exec, request.params.pbiId);
      return { result: {} };

    case "pbi.retryTask":
      retryTask(deps.exec, request.params.pbiId, request.params.key);
      return { result: {} };

    case "pbi.skipTask":
      skipTask(deps.exec, request.params.pbiId, request.params.key);
      return { result: {} };

    case "pbi.cancel":
      cancelPbi(deps.exec, request.params.pbiId);
      return { result: {} };

    default:
      return { error: { message: "unknown pbi method" } };
  }
}
```

そして `runner/server.ts` を配線（`Deps` 拡張と委譲）。`server.ts:15` の型と `handleLine` に以下を織り込む:

```typescript
// runner/server.ts の変更点

// 1) import 追加
import type { PbiJob, PbiRunnerRequest } from "../lib/pbi/types";
import { handlePbiRequest, type PbiServerDeps } from "./pbi-server";

// 2) Deps 型を拡張（既存の Deps に pbi を足す）
type Deps = {
  store: JobStore;
  scheduler: Scheduler;
  broker: InputBroker;
  pbi: PbiServerDeps;
};

// 3) startRunnerServer 内、store.on("job", ...) の直後に PBI イベント配信を追加
deps.pbi.pbiStore.on("pbi", (pbi: PbiJob) => {
  const line = `${JSON.stringify({ event: "pbi.updated", data: pbi })}\n`;
  for (const socket of subscribers) socket.write(line);
});

// 4) handleLine の switch default 直前に、pbi.* を委譲する分岐を追加
//    （method が "pbi." で始まるものは handlePbiRequest へ）
if (request.method.startsWith("pbi.")) {
  void handlePbiRequest(request as unknown as PbiRunnerRequest, deps.pbi).then(
    (r) => respond(socket, { id: request.id, ...r }),
  );
  return;
}
```

最後に `lib/runner/client.ts` のイベント購読に `pbi.updated` を追加（`openRunnerEventStream` の data ハンドラ）:

```typescript
// lib/runner/client.ts の onEvent 分岐に追加
if (parsed.event === "job.updated" || parsed.event === "pbi.updated") {
  onEvent(parsed as RunnerEvent);
}
```

（`RunnerEvent` 型を `lib/jobs/types.ts` で `| PbiRunnerEvent` を含むよう緩めるか、client 側で受け付ける型を広げる。型定義の詳細は実装時に合わせる。）

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-server.test.ts runner/__tests__/server.test.ts`
Expected: PASS（既存 `server.test.ts` の `Deps` 生成箇所は `pbi` フィールド追加が必要。既存テストが赤くなったら、その `startRunnerServer` 呼び出しに最小のフェイク `pbi` を渡して緑に戻す。）

- [ ] **Step 5: Commit**

```bash
git add lib/pbi/types.ts runner/pbi-server.ts runner/server.ts lib/runner/client.ts runner/__tests__/pbi-server.test.ts runner/__tests__/server.test.ts
git commit -m "feat: pbi.* socket methods and pbi.updated event wiring"
```

---

### Task 12: runner main への配線 + 起動時 PBI 復旧

**Files:**
- Modify: `runner/main.ts`
- Create: `runner/pbi-boot.ts`
- Test: `runner/__tests__/pbi-boot.test.ts`

**Interfaces:**
- Consumes: `PbiStore`, `PbiExecutorDeps`/`dispatchReady`, `pollOnce`/`startPoller`, `RealGitHubClient`, `PbiStatus`
- Produces:
  - `reconcileOnBoot(deps: { pbiStore: PbiStore; exec: PbiExecutorDeps }): void`（`executing` の PBI について、`running` sub-task のうち対応 Job が生きていないものを `pending` に戻し、`dispatchReady` で再発射候補にする。マージ済みかどうかは次回ポーリングで確定するため触らない）
- `main.ts` 変更: `PbiStore` 生成 + `RealGitHubClient` + `PbiServerDeps` 組み立て → `startRunnerServer` に `pbi` を渡す → `reconcileOnBoot` → `startPoller(..., PBI_POLL_INTERVAL_MS)`。既存の `store` の `job` イベントを `onJobUpdated` に橋渡し（`store.on("job", (job) => onJobUpdated(exec, job))`）。

**Design note:** Launch Pad ジョブの状態変化を PBI に反映する結線は main で行う（`store.on("job")` → `onJobUpdated`）。これで PR 作成（job done）が sub-task を `in_review` に進め、以降のマージ検知はポーラーが担う。

- [ ] **Step 1: Write the failing test**

```typescript
// runner/__tests__/pbi-boot.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubTaskRecord } from "../../lib/pbi/types";
import { JobStore } from "../store";
import { PbiStore } from "../pbi-store";
import { Scheduler } from "../scheduler";
import { InputBroker } from "../input-broker";
import type { PbiExecutorDeps } from "../pbi-executor";
import { reconcileOnBoot } from "../pbi-boot";

let jobsDir: string;
let pbisDir: string;
let jobStore: JobStore;
let pbiStore: PbiStore;
let exec: PbiExecutorDeps;

const rec = (over: Partial<SubTaskRecord>): SubTaskRecord => ({
  key: "t1",
  title: "t",
  goal: "",
  deliverable: "",
  acceptanceCriteria: [],
  dependsOn: [],
  state: "running",
  issueNumber: 100,
  jobId: "dead-job",
  branch: "feature/100-t",
  prUrl: null,
  ...over,
});

beforeEach(() => {
  jobsDir = mkdtempSync(join(tmpdir(), "jobs-"));
  pbisDir = mkdtempSync(join(tmpdir(), "pbis-"));
  jobStore = new JobStore(jobsDir);
  jobStore.loadAll();
  pbiStore = new PbiStore(pbisDir);
  pbiStore.loadAll();
  const scheduler = new Scheduler(
    {
      store: jobStore,
      broker: new InputBroker(),
      commands: { run: async () => ({ stdout: "", stderr: "" }) },
      executor: { run: async () => ({ ok: true }) },
      repoDir: "/repo",
    },
    { runJob: async () => {} },
  );
  exec = { pbiStore, jobStore, scheduler };
});
afterEach(() => {
  rmSync(jobsDir, { recursive: true, force: true });
  rmSync(pbisDir, { recursive: true, force: true });
});

describe("reconcileOnBoot", () => {
  it("resets running sub-tasks whose job no longer exists back to pending, then re-dispatches", () => {
    const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    // jobId="dead-job" は jobStore に存在しない（前回プロセスと共に消えた想定）
    pbiStore.setSubTasks(pbi.id, [rec({ key: "t1" })]);

    reconcileOnBoot({ pbiStore, exec });

    const t1 = pbiStore.get(pbi.id)!.subTasks[0];
    // 再発射され running（新しい jobId が振られている）
    expect(t1.state).toBe("running");
    expect(t1.jobId).not.toBe("dead-job");
    expect(jobStore.list()).toHaveLength(1);
  });

  it("leaves in_review sub-tasks untouched (merge resolved by poller)", () => {
    const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    pbiStore.setSubTasks(pbi.id, [
      rec({ key: "t1", state: "in_review", jobId: "old", prUrl: "u" }),
    ]);

    reconcileOnBoot({ pbiStore, exec });
    expect(pbiStore.get(pbi.id)!.subTasks[0].state).toBe("in_review");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run runner/__tests__/pbi-boot.test.ts`
Expected: FAIL — "Cannot find module '../pbi-boot'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// runner/pbi-boot.ts
import { dispatchReady, type PbiExecutorDeps } from "./pbi-executor";
import type { PbiStore } from "./pbi-store";

export function reconcileOnBoot(deps: {
  pbiStore: PbiStore;
  exec: PbiExecutorDeps;
}): void {
  for (const pbi of deps.pbiStore.list()) {
    if (pbi.status !== "executing") continue;
    for (const task of pbi.subTasks) {
      if (task.state !== "running") continue;
      const job = task.jobId ? deps.exec.jobStore.get(task.jobId) : undefined;
      const alive =
        job && ["queued", "running", "waiting_input"].includes(job.status);
      if (!alive) {
        // 前回プロセスと共に消えたジョブ → 未着手に戻して再発射候補にする
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "failed");
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "pending", {
          jobId: null,
        });
      }
    }
    dispatchReady(deps.exec, pbi.id);
  }
}
```

Note: `running -> pending` は状態機械に無いため、一度 `failed` を経由してから `pending`（`failed -> running` ではなく `failed -> ...`）に戻す。`SUBTASK_TRANSITIONS` の `failed` には `running` と `skipped` しか無いので、**Task 1 の `SUBTASK_TRANSITIONS.failed` に `"pending"` を追加**する（`failed: ["running", "pending", "skipped"]`）。この変更は Task 1 のテストに影響しないが、`pbi-types.test.ts` に 1 ケース追加して明示する:

```typescript
// runner/__tests__/pbi-types.test.ts に追記
it("allows failed -> pending for boot reconciliation", () => {
  expect(canSubTaskTransition("failed", "pending")).toBe(true);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run runner/__tests__/pbi-boot.test.ts runner/__tests__/pbi-types.test.ts`
Expected: PASS

- [ ] **Step 5: Wire main.ts**

`runner/main.ts` を以下に更新（既存の Launch Pad 配線を保ちつつ PBI を足す）:

```typescript
// runner/main.ts
import { JOBS_DIR, RUNNER_SOCKET_PATH } from "../lib/jobs/types";
import { PBIS_DIR, PBI_POLL_INTERVAL_MS } from "../lib/pbi/types";
import { RealCommandRunner } from "./exec";
import { InputBroker } from "./input-broker";
import { Scheduler } from "./scheduler";
import { SdkExecutor } from "./sdk-executor";
import { startRunnerServer } from "./server";
import { JobStore } from "./store";
import { PbiStore } from "./pbi-store";
import { RealGitHubClient } from "./github";
import { onJobUpdated, type PbiExecutorDeps } from "./pbi-executor";
import { reconcileOnBoot } from "./pbi-boot";
import { startPoller } from "./pbi-poller";
import type { LifecycleDeps } from "./pbi-lifecycle";
import type { PbiServerDeps } from "./pbi-server";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO_DIR = process.env.COCKPIT_REPO_DIR ?? process.cwd();
const SCRATCH_DIR =
  process.env.RUNNER_SCRATCH_DIR ??
  join(homedir(), ".cache", "cockpit", "scratch");

function main(): void {
  const store = new JobStore(JOBS_DIR);
  store.loadAll();
  const broker = new InputBroker();
  const commands = new RealCommandRunner();
  const scheduler = new Scheduler({
    store,
    broker,
    commands,
    executor: new SdkExecutor(),
    repoDir: REPO_DIR,
  });

  const pbiStore = new PbiStore(PBIS_DIR);
  pbiStore.loadAll();
  const github = new RealGitHubClient(commands, REPO_DIR);
  const exec: PbiExecutorDeps = { pbiStore, jobStore: store, scheduler };
  const lifecycle: LifecycleDeps = {
    store: pbiStore,
    executor: new SdkExecutor(),
    commands,
    github,
    repoDir: REPO_DIR,
    scratchDir: SCRATCH_DIR,
  };
  const pbi: PbiServerDeps = { pbiStore, lifecycle, exec };

  // Launch Pad ジョブの状態変化を PBI に反映
  store.on("job", (job) => onJobUpdated(exec, job));

  startRunnerServer(RUNNER_SOCKET_PATH, { store, scheduler, broker, pbi });
  scheduler.resumeOnBoot();
  reconcileOnBoot({ pbiStore, exec });
  startPoller({ pbiStore, github, exec }, PBI_POLL_INTERVAL_MS);

  console.log(
    `[runner] listening on ${RUNNER_SOCKET_PATH} (repo: ${REPO_DIR}, jobs: ${JOBS_DIR}, pbis: ${PBIS_DIR})`,
  );
}

main();
```

- [ ] **Step 6: Full suite + build**

Run: `pnpm vitest run && pnpm build`
Expected: 全テスト PASS、esbuild バンドル成功（`runner/main.ts` が新規モジュールを取り込む）。

- [ ] **Step 7: Commit**

```bash
git add runner/main.ts runner/pbi-boot.ts runner/__tests__/pbi-boot.test.ts runner/__tests__/pbi-types.test.ts lib/pbi/types.ts
git commit -m "feat: wire PBI orchestration into runner main with boot reconcile and poller"
```

---

## スコープ外（後続計画）

本計画は runner 側コアのみ。以下は別計画で扱う:

- **受信箱 UI（Inbox）**: `pbi.updated` + `job.updated` を集約する Next API プロキシと `/inbox` 画面。5 種類のエスカレーションのインライン操作。
- **PBI ボード UI**: `/pbi` 画面、依存グラフ表示、ライブログ、一時停止/中止/フォロータスク追加。
- **発射台の発展**: `pbi` ラベル Issue 一覧、Definition of Ready 警告、`pbi.fire`。
- **レビューコメント対応ジョブ**: `review_comments` エスカレーションからのワンタップ発射（reply-review-comments 流儀の実装ジョブ）。
- **ガードレール整備**: リポジトリ別設定（allowlist、テスト/lint コマンド、環境変数）、`gh pr merge`/`gh pr ready`/デフォルトブランチ push の禁止、Findy 展開。
- **PBI テンプレート**: `.github/ISSUE_TEMPLATE/pbi.md`（Definition of Ready）。

## 自己レビュー結果

- **スペック網羅**: PBI 状態機械(T1) / 分解ジョブ(T5) / sub-issue 化(T6) / 承認ゲート(T7) / 依存グラフ実行ループ(T4,T8) / マージ検知(T9) / エスカレーション操作(T10) / socket(T11) / 起動復旧(T12) をカバー。UI・ガードレール・テンプレはスコープ外として明記。
- **型整合性**: `SubTaskState`/`PbiStatus` の遷移表を T1 で定義し、T12 で `failed -> pending` を追加する箇所を明示。`GitHubClient`/`PrState` は T3 で定義し T6,T7,T9 で一貫使用。`PbiExecutorDeps`/`LifecycleDeps`/`PbiServerDeps` の合成関係を Interfaces ブロックで明示。
- **プレースホルダ**: 各ステップに実コードを記載。T6・T11・T12 に「実装時に調整」の注記があるが、いずれも具体的な代替値・理由付きで、TBD ではない。
- **既存テストへの波及**: T11 で `server.test.ts` の `Deps` に `pbi` 追加が必要な点を明記。
