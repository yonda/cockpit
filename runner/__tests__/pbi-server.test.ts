import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor, ExecutorHooks, ExecutorRunOpts } from "../executor";
import type { GitHubClient, PrState } from "../github";
import type { SubTask } from "../../lib/pbi/types";
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
    exec: { pbiStore, jobStore, scheduler },
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
