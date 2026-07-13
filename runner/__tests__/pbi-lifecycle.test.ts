import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor, ExecutorHooks, ExecutorRunOpts } from "../executor";
import type { GitHubClient, PrState } from "../github";
import type { SubTask } from "../../lib/pbi/types";
import { PbiStore } from "../pbi-store";
import {
  approveDecomposition,
  rejectDecomposition,
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

const makeDeps = (
  executor: AgentExecutor,
  github: GitHubClient,
): LifecycleDeps => ({
  store,
  executor,
  github,
  prepareCwd: async () => ({
    cwd: scratch,
    githubToken: "tok-acme",
    cleanup: async () => {},
  }),
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

  it("fails PBI when decomposition exceeds MAX_DECOMPOSITION_ATTEMPTS", async () => {
    const github = new FakeGitHub();
    const deps = makeDeps(new WritingExecutor(tasks), github);
    const pbi = store.create({ repo: "r", issueNumber: 42, title: "PBI" });
    // First decomposition brings status to awaiting_approval with decompositionAttempts=1
    await startDecomposition(deps, pbi.id, new AbortController().signal);
    // Fast-forward decompositionAttempts to the max
    store.update(pbi.id, { decompositionAttempts: 5 });

    // Now revise - will increment to 6, exceeding MAX (5)
    await reviseDecomposition(
      deps,
      pbi.id,
      "t1 をさらに分割して",
      new AbortController().signal,
    );

    const after = store.get(pbi.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/上限/);
  });
});

describe("rejectDecomposition", () => {
  it("transitions status to cancelled", async () => {
    const github = new FakeGitHub();
    const deps = makeDeps(new WritingExecutor(tasks), github);
    const pbi = store.create({ repo: "r", issueNumber: 42, title: "PBI" });
    await startDecomposition(deps, pbi.id, new AbortController().signal);

    await rejectDecomposition(deps, pbi.id);

    expect(store.get(pbi.id)!.status).toBe("cancelled");
  });
});
