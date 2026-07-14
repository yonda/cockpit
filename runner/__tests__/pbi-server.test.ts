import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor, ExecutorHooks, ExecutorRunOpts } from "../executor";
import type { GitHubClient, PrState } from "../github";
import type { SubTask, SubTaskRecord } from "../../lib/pbi/types";
import { InputBroker } from "../input-broker";
import { JobStore } from "../store";
import { PbiStore } from "../pbi-store";
import { RepoRegistry } from "../repo-registry";
import { Scheduler } from "../scheduler";
import { handlePbiRequest, type PbiServerDeps } from "../pbi-server";

let dir: string;
let jobsDir: string;
let deps: PbiServerDeps;
let github: FakeGitHub;
let cwds: string[];

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
  async searchAssignedOpenIssues() {
    return [];
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
  jobsDir = mkdtempSync(join(tmpdir(), "jobs-"));
  cwds = [];
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
      executor: { run: async () => ({ ok: true as const }) },
      registry: new RepoRegistry([]),
      resolveToken: () => "test-token",
    },
    {
      runJob: async (schedDeps, jobId) => {
        schedDeps.store.transition(jobId, "running");
      },
    },
  );
  deps = {
    pbiStore,
    lifecycle: {
      store: pbiStore,
      executor: new WritingExecutor(),
      github,
      prepareCwd: async () => {
        const cwd = mkdtempSync(join(tmpdir(), "decomp-"));
        cwds.push(cwd);
        return { cwd, githubToken: "tok-acme", cleanup: async () => {} };
      },
    },
    exec: { pbiStore, jobStore, scheduler, github },
  };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(jobsDir, { recursive: true, force: true });
  for (const cwd of cwds) rmSync(cwd, { recursive: true, force: true });
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

  it("pbi.fire: a rejecting fire-and-forget decomposition marks the PBI failed instead of crashing the process", async () => {
    // prepareCwd を reject させ、startDecomposition の fire-and-forget チェーンで
    // 例外を発生させる（RealGitHubClient の gh 非ゼロ終了と同様の失敗モード）。
    // .catch(failPbiSafely) が付いていないと、これは unhandledRejection として
    // プロセスを落とす（Node 22 は unhandled-rejections=throw がデフォルト）。
    let unhandled: unknown;
    const onUnhandledRejection = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      deps.lifecycle = {
        ...deps.lifecycle,
        prepareCwd: async () => {
          throw new Error("gh: authentication failed");
        },
      };

      const res = await handlePbiRequest(
        {
          id: "1",
          method: "pbi.fire",
          params: { repo: "yonda/cockpit", issueNumber: 43, title: "PBI" },
        },
        deps,
      );
      const created = (res.result as { pbi: { id: string } }).pbi;

      // fire-and-forget チェーンの .catch が走るまでマイクロタスクを複数回逃がす
      await flush();
      await flush();

      const pbi = deps.pbiStore.get(created.id)!;
      expect(pbi.status).toBe("failed");
      expect(pbi.error).toMatch(/gh: authentication failed/);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    // 上記の間に unhandledRejection が一切発生していないことを保証する
    expect(unhandled).toBeUndefined();
  });

  // --- pbi.fire サーバー側冪等ガード（同一 repo#issue の active な PBI があれば拒否） ---
  //
  // UI をすり抜けた二重リクエストへの最終防衛（defense in depth）を回帰から守る。
  // ガード本体は pbi-server.ts の pbi.fire ケースにあり、
  //   !["completed", "failed", "cancelled"].includes(p.status)
  // つまり decomposing / awaiting_approval / executing の PBI があれば拒否する。

  // 指定 status の PBI を同期的に用意する（分解の fire-and-forget を経由しない）。
  const seedPbi = (
    repo: string,
    issueNumber: number,
    status: "decomposing" | "awaiting_approval" | "executing" | "completed" | "failed" | "cancelled",
  ) => {
    const pbi = deps.pbiStore.create({ repo, issueNumber, title: "seed" });
    // create 直後は decomposing。terminal / executing へは許可された経路で遷移する。
    const path: Record<typeof status, ("awaiting_approval" | "executing" | "completed" | "failed" | "cancelled")[]> = {
      decomposing: [],
      awaiting_approval: ["awaiting_approval"],
      executing: ["awaiting_approval", "executing"],
      completed: ["awaiting_approval", "executing", "completed"],
      failed: ["failed"],
      cancelled: ["cancelled"],
    };
    for (const to of path[status]) deps.pbiStore.transition(pbi.id, to);
    return pbi;
  };

  const fire = (repo: string, issueNumber: number) =>
    handlePbiRequest(
      { id: "f", method: "pbi.fire", params: { repo, issueNumber, title: "PBI" } },
      deps,
    );

  for (const status of ["decomposing", "awaiting_approval", "executing"] as const) {
    it(`pbi.fire rejects when an active (${status}) PBI already exists for the same repo#issue and creates no second PBI`, async () => {
      seedPbi("yonda/cockpit", 42, status);
      const before = deps.pbiStore.list().length;

      const res = await fire("yonda/cockpit", 42);

      expect(res.error?.message).toMatch(/既に進行中/);
      expect(res.result).toBeUndefined();
      // 2 個目の PBI は作られない
      expect(deps.pbiStore.list().length).toBe(before);
    });
  }

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`pbi.fire re-fires when only a terminal (${status}) PBI exists for the same repo#issue`, async () => {
      const seeded = seedPbi("yonda/cockpit", 42, status);
      const before = deps.pbiStore.list().length;

      const res = await fire("yonda/cockpit", 42);

      const created = (res.result as { pbi: { id: string } }).pbi;
      expect(created.id).toMatch(/^pbi-/);
      expect(created.id).not.toBe(seeded.id);
      // 新しい PBI が 1 件増える
      expect(deps.pbiStore.list().length).toBe(before + 1);

      await flush(); // fire-and-forget の分解完了を待って後片付けを安定させる
    });
  }

  it("pbi.fire scopes the duplicate guard to the same repo AND issueNumber", async () => {
    seedPbi("yonda/cockpit", 42, "executing");
    const before = deps.pbiStore.list().length;

    // 同 issueNumber・別 repo は別物として発射できる
    const otherRepo = await fire("yonda/other", 42);
    expect((otherRepo.result as { pbi: { id: string } }).pbi.id).toMatch(/^pbi-/);
    // 同 repo・別 issueNumber も別物として発射できる
    const otherIssue = await fire("yonda/cockpit", 43);
    expect((otherIssue.result as { pbi: { id: string } }).pbi.id).toMatch(/^pbi-/);

    expect(deps.pbiStore.list().length).toBe(before + 2);
    await flush();
  });

  // --- pbi.approve 連打（二重承認）ガード ---
  //
  // UI をすり抜けた二重 approve への最終防衛。ガードが無いと、fire-and-forget の
  // approveDecomposition が 2 本走り、2 本目が executing -> executing の不正遷移で
  // throw → .catch(failPbiSafely) が実行中の PBI を failed に落としてしまう。
  it("pbi.approve rejects a second approve (連打) and keeps the PBI executing instead of failing it", async () => {
    const fired = await fire("yonda/cockpit", 77);
    const pbiId = (fired.result as { pbi: { id: string } }).pbi.id;
    await flush();
    expect(deps.pbiStore.get(pbiId)!.status).toBe("awaiting_approval");

    const first = await handlePbiRequest(
      { id: "a1", method: "pbi.approve", params: { pbiId } },
      deps,
    );
    // 2 回目は 1 回目の fire-and-forget チェーン完了前に届く連打を模す
    const second = await handlePbiRequest(
      { id: "a2", method: "pbi.approve", params: { pbiId } },
      deps,
    );
    await flush();
    await flush();
    await flush();

    // 1 回目は受理、2 回目は同期ガードで clean error（PBI を failed に落とさない）
    expect(first.error).toBeUndefined();
    expect(second.error?.message).toMatch(/承認できる状態ではありません/);
    // PBI は二重承認で failed に落ちず、正しく executing のまま進む
    expect(deps.pbiStore.get(pbiId)!.status).toBe("executing");
  });

  it("pbi.approve returns a clean error for an unknown pbiId without touching state", async () => {
    const res = await handlePbiRequest(
      { id: "a", method: "pbi.approve", params: { pbiId: "pbi-does-not-exist" } },
      deps,
    );
    expect(res.error?.message).toMatch(/承認できる状態ではありません \(unknown\)/);
  });

  const failedSubTask = (over: Partial<SubTaskRecord> = {}): SubTaskRecord => ({
    key: "t1",
    title: "types",
    goal: "g",
    deliverable: "d",
    acceptanceCriteria: ["ok"],
    dependsOn: [],
    state: "failed",
    issueNumber: 100,
    jobId: null,
    branch: "feature/100-t1",
    prUrl: null,
    ...over,
  });

  const executingPbiWith = (task: SubTaskRecord): string => {
    const pbi = deps.pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    deps.pbiStore.transition(pbi.id, "awaiting_approval");
    deps.pbiStore.transition(pbi.id, "executing");
    deps.pbiStore.setSubTasks(pbi.id, [task]);
    return pbi.id;
  };

  it("pbi.markTaskDone moves a failed sub-task to done_no_pr when no merged PR exists", async () => {
    const pbiId = executingPbiWith(failedSubTask());

    const res = await handlePbiRequest(
      { id: "1", method: "pbi.markTaskDone", params: { pbiId, key: "t1" } },
      deps,
    );

    expect(res.error).toBeUndefined();
    const after = deps.pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("done_no_pr");
    expect(after.status).toBe("completed");
  });

  it("pbi.markTaskDone moves a failed sub-task to merged when the branch PR is merged", async () => {
    github.prStateForBranch = async () => ({
      kind: "merged",
      url: "https://pr/9",
    });
    const pbiId = executingPbiWith(failedSubTask());

    await handlePbiRequest(
      { id: "1", method: "pbi.markTaskDone", params: { pbiId, key: "t1" } },
      deps,
    );

    const after = deps.pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("merged");
    expect(after.subTasks[0].prUrl).toBe("https://pr/9");
  });

  it("pbi.markTaskDone on a non-failed sub-task rejects (canSubTaskTransition), which server.ts returns as a socket error", async () => {
    const pbiId = executingPbiWith(failedSubTask({ state: "in_review" }));

    await expect(
      handlePbiRequest(
        { id: "1", method: "pbi.markTaskDone", params: { pbiId, key: "t1" } },
        deps,
      ),
    ).rejects.toThrow(/invalid sub-task transition/);
    expect(deps.pbiStore.get(pbiId)!.subTasks[0].state).toBe("in_review");
  });

  it("pbi.pause on an unknown pbiId rejects the handlePbiRequest promise (synchronous PbiStore.mustGet throw propagates through the async fn)", async () => {
    // pausePbi -> PbiStore.update -> mustGet は同期的に throw する。
    // handlePbiRequest は async 関数なので、これは reject された Promise になる。
    // runner/server.ts の handleLine は、この reject を .then(onFulfilled, onRejected)
    // の第二引数で拾ってエラーレスポンスを返す（Fix 2）。ここでは reject が
    // 発生する「真実のレイヤー」= handlePbiRequest 自体で検証する。
    await expect(
      handlePbiRequest(
        { id: "1", method: "pbi.pause", params: { pbiId: "pbi-does-not-exist" } },
        deps,
      ),
    ).rejects.toThrow(/unknown pbi/);
  });
});
