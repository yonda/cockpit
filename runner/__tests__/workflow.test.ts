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
  /** 作成済み worktree のセット (git worktree add が呼ばれたブランチ) */
  createdWorktrees = new Set<string>();
  /** show-ref が成功扱いするブランチ (既存ブランチのシミュレート) */
  existingBranches = new Set<string>();

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
    if (cmd === "git" && args[0] === "show-ref") {
      // refs/heads/<branch> は args の末尾
      const ref = args[args.length - 1];
      if (this.existingBranches.has(ref.replace("refs/heads/", ""))) {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`show-ref: ${ref} not found`); // 未存在は非ゼロ終了を模す
    }
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
      // git worktree add <path> [-b branch] ... または git worktree add <path> <branch>
      const bIndex = args.indexOf("-b");
      let branch: string | undefined;
      if (bIndex >= 0) {
        branch = args[bIndex + 1]; // -b branch format
      } else if (args[3]) {
        branch = args[3]; // add <path> <branch> format
      }
      if (branch) {
        this.createdWorktrees.add(branch);
      }
      return { stdout: "", stderr: "" };
    }
    if (cmd === "git" && args[0] === "worktree") {
      // 作成済みブランチだけ list に出す
      if (this.createdWorktrees.size > 0) {
        const entries = Array.from(this.createdWorktrees)
          .map(
            (branch) =>
              `worktree /tmp/cockpit-wt/${branch}\nbranch refs/heads/${branch}`,
          )
          .join("\n");
        return {
          stdout: entries + "\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
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
    repoDir: "/tmp/cockpit",
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
    // 新規ブランチは origin/main 起点で plain git worktree add され、依存を入れる
    expect(
      deps.commands.calls.some((c) =>
        c.startsWith("git worktree add") &&
        c.includes("feature/1-test-issue") &&
        c.includes("origin/main"),
      ),
    ).toBe(true);
    expect(deps.commands.calls).toContain("pnpm install");
    // git wt (グローバル hook 継承) は使わない
    expect(deps.commands.calls.some((c) => c.startsWith("git wt"))).toBe(false);
  });

  it("reuses an existing branch without an origin/main start-point", async () => {
    const deps = makeDeps();
    deps.commands.existingBranches.add("feature/1-test-issue");
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    expect(store.get(job.id)!.status).toBe("done");
    // 既存ブランチは起点指定なしで add する (origin/main を上書きしない)
    expect(deps.commands.calls).toContain(
      "git worktree add /tmp/cockpit-wt/feature/1-test-issue feature/1-test-issue",
    );
  });

  it("does not instruct closing keywords so the issue stays open until merge", async () => {
    const deps = makeDeps();
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const prompt = deps.executor.lastOpts!.prompt;
    // GitHub の closing keyword を一切書かせない（push だけで Issue が早期
    // クローズするのを防ぐ）。closes だけでなく fixes/resolves 等の全系統を検査。
    expect(prompt).not.toMatch(
      /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*#\d/i,
    );
    // 代わりに、関連付けは refs で行う旨（クローズをマージ後/人間に委ねる）を明示している
    expect(prompt).toMatch(/refs #\d/);
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

  it("clears pendingInput when the executor throws while waiting_input", async () => {
    const deps = makeDeps();
    deps.executor.run = async (_opts, hooks) => {
      void hooks.requestInput({
        id: "in-1",
        kind: "permission",
        toolName: "Bash",
        input: {},
        createdAt: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 10)); // waiting_input へ遷移するのを待つ
      throw new Error("sdk crashed");
    };
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });
    await runIssueJob(deps, job.id, new AbortController().signal);
    const final = store.get(job.id)!;
    expect(final.status).toBe("failed");
    expect(final.error).toBe("sdk crashed");
    expect(final.pendingInput).toBeNull();
  });

  it("cleans up the broker when the executor returns ok:false after a dangling requestInput", async () => {
    const deps = makeDeps();
    deps.executor.run = async (_opts, hooks) => {
      // fire-and-forget: 呼び出し元は await せずに終了することがある
      void hooks.requestInput({
        id: "in-1",
        kind: "permission",
        toolName: "Bash",
        input: {},
        createdAt: new Date().toISOString(),
      });
      return { ok: false, error: "boom" };
    };
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const final = store.get(job.id)!;
    expect(final.status).toBe("failed");
    expect(final.pendingInput).toBeNull();
    // broker の entry も掃除されていること (漏れた entry には resolve が届かない)
    expect(deps.broker.resolve(job.id, "in-1", { kind: "allow" })).toBe(false);
  });

  it("cancel during waiting_input resolves and leaves the job cancelled", async () => {
    const deps = makeDeps();
    deps.executor.askPermission = true;
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });
    const controller = new AbortController();
    const running = runIssueJob(deps, job.id, controller.signal);

    await new Promise<void>((resolve) => {
      store.on("job", (j) => {
        if (j.id === job.id && j.status === "waiting_input") resolve();
      });
    });

    // キャンセル側の契約: signal abort + broker.abort + cancelled 遷移
    controller.abort();
    deps.broker.abort(job.id);
    store.transition(job.id, "cancelled", { pendingInput: null });

    await running; // ハングしないこと
    expect(store.get(job.id)!.status).toBe("cancelled");
    expect(deps.executor.receivedResponse).toEqual({
      kind: "deny",
      message: "job cancelled",
    });
  });

  it("uses a review-reply prompt when the job kind is review_reply", async () => {
    const deps = makeDeps();
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 9,
      issueTitle: "検索改善",
      branch: "feature/9-search",
      kind: "review_reply",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const prompt = deps.executor.lastOpts!.prompt;
    expect(prompt).toMatch(/レビュー/);
    expect(prompt).not.toMatch(/(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*#\d/i);
    // review-reply は新しい実装ではなく PR への追従なので、既存 worktree を再利用する
    expect(deps.commands.calls).toContain(
      "git worktree list --porcelain",
    );
  });
});
