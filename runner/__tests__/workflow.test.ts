import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PendingInput,
  PendingInputResponse,
} from "../../lib/jobs/types";
import { InputBroker } from "../input-broker";
import { RepoRegistry, type RepoConfig } from "../repo-registry";
import { JobStore } from "../store";
import type {
  AgentExecutor,
  CommandRunner,
  ExecutorHooks,
  ExecutorRunOpts,
} from "../executor";
import { buildBranchName, runIssueJob, type WorkflowDeps } from "../workflow";
import { NO_CHANGES_MARKER, type SubTaskRecord } from "../../lib/pbi/types";
import type { GitHubClient, PrState } from "../github";
import { PbiStore } from "../pbi-store";
import { Scheduler } from "../scheduler";
import { onJobUpdated, type PbiExecutorDeps } from "../pbi-executor";
import { pollOnce } from "../pbi-poller";

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
  /**
   * calls と並行して各呼び出しの opts (cwd/env) を記録する。CommandRunner.run の
   * 実シグネチャどおり cwd/env を受け取り、per-repo 配線 (Task 6) を検証できるようにする。
   */
  callOpts: Array<{
    cmd: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
  }> = [];
  /** `gh pr list` が返す PR の配列 (--state all 相当)。空配列なら PR なし */
  prs: Array<{ url: string; state: string }> = [
    { url: "https://github.com/yonda/cockpit/pull/9", state: "OPEN" },
  ];
  /** `gh api .../comments` が返すコメント本文の配列 */
  issueComments: string[] = [];
  /** 作成済み worktree のセット (git worktree add が呼ばれたブランチ) */
  createdWorktrees = new Set<string>();
  /** show-ref が成功扱いするブランチ (既存ブランチのシミュレート) */
  existingBranches = new Set<string>();

  async run(
    cmd: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ) {
    const line = [cmd, ...args].join(" ");
    this.calls.push(line);
    this.callOpts.push({ cmd, args, cwd: opts.cwd, env: opts.env });
    if (cmd === "gh" && args[0] === "api") {
      return {
        stdout: JSON.stringify(this.issueComments.map((body) => ({ body }))),
        stderr: "",
      };
    }
    if (cmd === "gh" && args[0] === "issue") {
      return {
        stdout: JSON.stringify({ title: "test issue", body: "本文です" }),
        stderr: "",
      };
    }
    if (cmd === "gh" && args[0] === "pr") {
      return {
        stdout: JSON.stringify(this.prs),
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

/** テスト既定のリポジトリ設定。既存テストの cwd 期待値 (/tmp/cockpit, origin/main) を保つ */
const DEFAULT_REPO_CONFIG: RepoConfig = {
  repo: "yonda/cockpit",
  path: "/tmp/cockpit",
  baseBranch: "main",
  tokenOwner: "yonda",
};

function makeRegistry(configs: RepoConfig[] = [DEFAULT_REPO_CONFIG]): RepoRegistry {
  return new RepoRegistry(configs);
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
    registry: makeRegistry(),
    resolveToken: (_owner: string) => "test-token",
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
    deps.commands.prs = [];
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

  it("queries PRs with --state all so merged PRs are visible", async () => {
    const deps = makeDeps();
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    expect(deps.commands.calls).toContain(
      "gh pr list --head feature/1-test-issue --state all --json url,state",
    );
  });

  it("transitions to done with the PR url when the branch PR is already merged", async () => {
    const deps = makeDeps();
    deps.commands.prs = [
      { url: "https://github.com/yonda/cockpit/pull/9", state: "MERGED" },
    ];
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const final = store.get(job.id)!;
    expect(final.status).toBe("done");
    expect(final.prUrl).toBe("https://github.com/yonda/cockpit/pull/9");
    expect(final.error).toBeNull();
  });

  it("prefers the open PR when both open and merged PRs exist for the branch", async () => {
    const deps = makeDeps();
    deps.commands.prs = [
      { url: "https://github.com/yonda/cockpit/pull/8", state: "MERGED" },
      { url: "https://github.com/yonda/cockpit/pull/9", state: "OPEN" },
    ];
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const final = store.get(job.id)!;
    expect(final.status).toBe("done");
    expect(final.prUrl).toBe("https://github.com/yonda/cockpit/pull/9");
  });

  it("falls back to the marker check when the only PR is closed unmerged", async () => {
    const deps = makeDeps();
    deps.commands.prs = [
      { url: "https://github.com/yonda/cockpit/pull/9", state: "CLOSED" },
    ];
    deps.commands.issueComments = ["ただの進捗コメント（マーカーなし）"];
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const final = store.get(job.id)!;
    // unmerged closed は成果とみなさず、マーカーなしなら従来どおり failed
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/draft PR/);
    // マーカーの外部検証 (gh api) にフォールバックしている
    expect(deps.commands.calls).toContain(
      "gh api /repos/yonda/cockpit/issues/1/comments",
    );
  });

  it("closed unmerged PR + marker comment resolves as done (noChanges)", async () => {
    const deps = makeDeps();
    deps.commands.prs = [
      { url: "https://github.com/yonda/cockpit/pull/9", state: "CLOSED" },
    ];
    deps.commands.issueComments = [
      `検証しました。既に対応済みのため差分は不要です。\n${NO_CHANGES_MARKER}`,
    ];
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const final = store.get(job.id)!;
    expect(final.status).toBe("done");
    expect(final.noChanges).toBe(true);
    expect(final.prUrl).toBeNull();
  });

  it("instructs how to declare no-changes with the marker comment", async () => {
    const deps = makeDeps();
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 7,
      issueTitle: "test issue",
      branch: "feature/7-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const prompt = deps.executor.lastOpts!.prompt;
    // buildPrompt に「変更不要なら PR を作らずマーカー付きコメントを投稿」指示がある
    expect(prompt).toContain(NO_CHANGES_MARKER);
    expect(prompt).toMatch(/gh issue comment/);
  });

  it("tells the agent to run verification commands one at a time, not chained", async () => {
    const deps = makeDeps();
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 8,
      issueTitle: "test issue",
      branch: "feature/8-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const prompt = deps.executor.lastOpts!.prompt;
    // Issue #75: 複合ワンライナー (`&&`/パイプ/リダイレクトを重ねたもの) はサンドボックス
    // 自動許可の判定を外れて承認待ちで停止しうるため、1 コマンドずつ実行させる指示がある
    expect(prompt).toContain("1 コマンドずつ");
    expect(prompt).toMatch(/&&/);
  });

  it("transitions to done (noChanges) when the issue has a marker comment but no PR", async () => {
    const deps = makeDeps();
    deps.commands.prs = []; // draft PR は見つからない
    deps.commands.issueComments = [
      `検証しました。既に対応済みのため差分は不要です。\n${NO_CHANGES_MARKER}`,
    ];
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const final = store.get(job.id)!;
    expect(final.status).toBe("done");
    expect(final.noChanges).toBe(true);
    expect(final.prUrl).toBeNull();
    // 担当 Issue のコメントを gh api で外部検証している
    expect(deps.commands.calls).toContain(
      "gh api /repos/yonda/cockpit/issues/1/comments",
    );
  });

  it("fails when no PR exists and no marker comment is present", async () => {
    const deps = makeDeps();
    deps.commands.prs = [];
    deps.commands.issueComments = ["ただの進捗コメント（マーカーなし）"];
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
    expect(final.noChanges).toBe(false);
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

  it("parallel jobs serialize git fetch origin main per repoDir while the rest runs concurrently", async () => {
    // fetch の実行区間を持たせて重なりを検出するフェイク
    class FetchTrackingCommands extends FakeCommands {
      activeFetches = 0;
      maxActiveFetches = 0;
      fetchCount = 0;

      async run(
        cmd: string,
        args: string[],
        opts: { cwd: string; env?: Record<string, string> },
      ) {
        if (cmd === "git" && args[0] === "fetch") {
          this.fetchCount++;
          this.activeFetches++;
          this.maxActiveFetches = Math.max(
            this.maxActiveFetches,
            this.activeFetches,
          );
          // 実行区間を持たせる (直列化されていなければここで区間が重なる)
          await new Promise((r) => setTimeout(r, 5));
          this.activeFetches--;
        }
        return super.run(cmd, args, opts);
      }
    }

    // 2 ジョブが同時にエージェント実行へ到達するまで互いに待つバリア。
    // fetch だけでなくジョブ全体が直列化されてしまうと、片方がここへ
    // 到達できずテストがタイムアウトする (= fetch のみの直列化を検証)。
    class BarrierExecutor implements AgentExecutor {
      started = 0;
      private waiters: (() => void)[] = [];

      async run(_opts: ExecutorRunOpts, hooks: ExecutorHooks) {
        hooks.onSessionId(`sess-${this.started}`);
        this.started++;
        if (this.started >= 2) {
          for (const w of this.waiters) w();
        } else {
          await new Promise<void>((r) => this.waiters.push(r));
        }
        return { ok: true as const };
      }
    }

    const commands = new FetchTrackingCommands();
    const executor = new BarrierExecutor();
    const deps = makeDeps({ commands, executor });

    const job1 = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "task one",
      branch: "feature/1-task-one",
    });
    const job2 = store.create({
      repo: "yonda/cockpit",
      issueNumber: 2,
      issueTitle: "task two",
      branch: "feature/2-task-two",
    });

    await Promise.all([
      runIssueJob(deps, job1.id, new AbortController().signal),
      runIssueJob(deps, job2.id, new AbortController().signal),
    ]);

    // fetch は 2 回呼ばれるが、同時には 1 本しか走らない
    expect(commands.fetchCount).toBe(2);
    expect(commands.maxActiveFetches).toBe(1);
    // fetch 後の処理は各ジョブで並行実行され、両ジョブとも完走する
    expect(executor.started).toBe(2);
    expect(store.get(job1.id)!.status).toBe("done");
    expect(store.get(job2.id)!.status).toBe("done");
  });

  it("parallel jobs on different repos fetch concurrently (serialization is per repoDir)", async () => {
    // 両方の fetch が同時に走るまで互いに待つバリア。repoDir 以外のキーで
    // 誤って全体直列化される退行が起きると、2 本目の fetch が開始されず
    // バリアが解除されないためテストがタイムアウトする (= 並行性を検証)。
    class FetchBarrierCommands extends FakeCommands {
      activeFetches = 0;
      maxActiveFetches = 0;
      fetchCount = 0;
      private waiters: (() => void)[] = [];

      async run(
        cmd: string,
        args: string[],
        opts: { cwd: string; env?: Record<string, string> },
      ) {
        if (cmd === "git" && args[0] === "fetch") {
          this.fetchCount++;
          this.activeFetches++;
          this.maxActiveFetches = Math.max(
            this.maxActiveFetches,
            this.activeFetches,
          );
          if (this.fetchCount >= 2) {
            for (const w of this.waiters) w();
          } else {
            await new Promise<void>((r) => this.waiters.push(r));
          }
          this.activeFetches--;
        }
        return super.run(cmd, args, opts);
      }
    }

    const otherRepoConfig: RepoConfig = {
      repo: "yonda/other-repo",
      path: "/tmp/other-repo",
      baseBranch: "main",
      tokenOwner: "yonda",
    };
    const commands = new FetchBarrierCommands();
    const deps = makeDeps({
      commands,
      registry: makeRegistry([DEFAULT_REPO_CONFIG, otherRepoConfig]),
    });

    const job1 = store.create({
      repo: "yonda/cockpit",
      issueNumber: 1,
      issueTitle: "task one",
      branch: "feature/1-task-one",
    });
    const job2 = store.create({
      repo: "yonda/other-repo",
      issueNumber: 2,
      issueTitle: "task two",
      branch: "feature/2-task-two",
    });

    await Promise.all([
      runIssueJob(deps, job1.id, new AbortController().signal),
      runIssueJob(deps, job2.id, new AbortController().signal),
    ]);

    // 別 repoDir の fetch は互いにブロックせず、実行区間が重なる
    expect(commands.fetchCount).toBe(2);
    expect(commands.maxActiveFetches).toBe(2);
    expect(store.get(job1.id)!.status).toBe("done");
    expect(store.get(job2.id)!.status).toBe("done");
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

  it("未登録リポジトリのジョブは failed になる", async () => {
    const deps = makeDeps({ registry: makeRegistry([]) }); // registry.resolve は常に null
    const job = store.create({
      repo: "acme/widget",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    const final = store.get(job.id)!;
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/リポジトリが未登録です/);
    expect(final.error).toMatch(/acme\/widget/);
    // 未登録なので worktree もエージェント実行も走らない
    expect(deps.commands.calls).toHaveLength(0);
    expect(deps.executor.lastOpts).toBeNull();
  });

  it("worktree add が origin/<baseBranch> を起点にする", async () => {
    const config: RepoConfig = {
      repo: "acme/widget",
      path: "/wt/x",
      baseBranch: "develop",
      tokenOwner: "acme",
    };
    const deps = makeDeps({ registry: makeRegistry([config]) });
    const job = store.create({
      repo: "acme/widget",
      issueNumber: 1,
      issueTitle: "test issue",
      branch: "feature/1-test-issue",
    });

    await runIssueJob(deps, job.id, new AbortController().signal);

    expect(store.get(job.id)!.status).toBe("done");
    expect(deps.commands.calls).toContain("git fetch origin develop");
    expect(
      deps.commands.calls.some(
        (c) =>
          c.startsWith("git worktree add") &&
          c.includes("feature/1-test-issue") &&
          c.includes("origin/develop"),
      ),
    ).toBe(true);

    // Task 6 の中心的な配線: git/gh コマンドは registry から解決した
    // config.path を cwd に使う (デフォルト設定の /tmp/cockpit ではないこと)。
    const gitAndGhCalls = deps.commands.callOpts.filter(
      (c) => c.cmd === "git" || c.cmd === "gh",
    );
    expect(gitAndGhCalls.length).toBeGreaterThan(0);
    for (const call of gitAndGhCalls) {
      expect(call.cwd).toBe("/wt/x");
    }

    // gh 呼び出しには resolveToken が返したトークンが env.GH_TOKEN として
    // 渡ること (実トークンではなくフェイクのプレースホルダで検証)。
    const ghCalls = deps.commands.callOpts.filter((c) => c.cmd === "gh");
    expect(ghCalls.length).toBeGreaterThan(0);
    for (const call of ghCalls) {
      expect(call.env?.GH_TOKEN).toBe("test-token");
    }
  });

  it("merged PR 完了が PBI 側の done → in_review → poller merged 検知に prUrl 付きで乗る", async () => {
    // job done (merged PR) → onJobUpdated → sub-task in_review (prUrl 付き) →
    // poller の merged 検知 → sub-task merged / PBI completed、という既存の
    // PBI 側フローが偽陰性なく成立することを end-to-end で確認する。
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
      async searchAssignedOpenIssues() {
        return [];
      }
    }

    const mergedUrl = "https://github.com/yonda/cockpit/pull/9";
    const pbisDir = mkdtempSync(join(tmpdir(), "pbis-"));
    try {
      const pbiStore = new PbiStore(pbisDir);
      pbiStore.loadAll();
      const pbi = pbiStore.create({
        repo: "yonda/cockpit",
        issueNumber: 42,
        title: "parent PBI",
      });
      pbiStore.transition(pbi.id, "awaiting_approval");
      pbiStore.transition(pbi.id, "executing");

      const deps = makeDeps();
      deps.commands.prs = [{ url: mergedUrl, state: "MERGED" }];
      const job = store.create({
        repo: "yonda/cockpit",
        issueNumber: 1,
        issueTitle: "test issue",
        branch: "feature/1-test-issue",
      });
      const subTask: SubTaskRecord = {
        key: "t1",
        title: "test issue",
        goal: "",
        deliverable: "",
        acceptanceCriteria: [],
        dependsOn: [],
        state: "running",
        issueNumber: 1,
        jobId: job.id,
        branch: "feature/1-test-issue",
        prUrl: null,
      };
      pbiStore.setSubTasks(pbi.id, [subTask]);

      const scheduler = new Scheduler(deps, {
        runJob: async (d, jobId) => {
          d.store.transition(jobId, "running");
        },
      });
      const exec: PbiExecutorDeps = { pbiStore, jobStore: store, scheduler };

      // 1. runIssueJob: merged PR でも done + prUrl になる（偽陰性 failed にならない）
      await runIssueJob(deps, job.id, new AbortController().signal);
      const doneJob = store.get(job.id)!;
      expect(doneJob.status).toBe("done");
      expect(doneJob.prUrl).toBe(mergedUrl);

      // 2. onJobUpdated: done を受けて sub-task が prUrl 付きで in_review に遷移する
      await onJobUpdated(exec, doneJob);
      const inReview = pbiStore.get(pbi.id)!.subTasks[0];
      expect(inReview.state).toBe("in_review");
      expect(inReview.prUrl).toBe(mergedUrl);

      // 3. poller: merged を検知して sub-issue close + sub-task merged + PBI completed
      const github = new FakeGitHub();
      github.prStates["feature/1-test-issue"] = { kind: "merged", url: mergedUrl };
      await pollOnce({ pbiStore, github, exec });

      const after = pbiStore.get(pbi.id)!;
      expect(after.subTasks[0].state).toBe("merged");
      expect(after.subTasks[0].prUrl).toBe(mergedUrl);
      expect(github.closed).toEqual([1]);
      expect(after.status).toBe("completed");
    } finally {
      rmSync(pbisDir, { recursive: true, force: true });
    }
  });
});
