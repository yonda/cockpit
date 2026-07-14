// runner/__tests__/pbi-actions.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubTaskRecord } from "../../lib/pbi/types";
import { JobStore } from "../store";
import { PbiStore } from "../pbi-store";
import { RepoRegistry } from "../repo-registry";
import { Scheduler } from "../scheduler";
import { InputBroker } from "../input-broker";
import type { GitHubClient, PrState } from "../github";
import { onJobUpdated, type PbiExecutorDeps } from "../pbi-executor";
import {
  cancelPbi,
  markTaskDone,
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
      registry: new RepoRegistry([]),
      resolveToken: () => "test-token",
    },
    { runJob: async (deps, jobId) => { deps.store.transition(jobId, "running"); } },
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

describe("markTaskDone", () => {
  class FakeGitHub implements GitHubClient {
    prState: PrState = { kind: "none" };
    prLookups: string[] = [];
    closedIssues: number[] = [];
    closeIssueError: Error | null = null;
    async fetchIssue() {
      return { title: "t", body: "" };
    }
    async createSubIssue() {
      return { number: 1, url: "u" };
    }
    async updateIssueBody() {}
    async closeIssue(_repo: string, number: number) {
      if (this.closeIssueError) throw this.closeIssueError;
      this.closedIssues.push(number);
    }
    async prStateForBranch(_repo: string, branch: string): Promise<PrState> {
      this.prLookups.push(branch);
      return this.prState;
    }
    async searchAssignedOpenIssues() {
      return [];
    }
  }

  let github: FakeGitHub;
  beforeEach(() => {
    github = new FakeGitHub();
    deps = { ...deps, github };
  });

  it("moves a failed task with a merged PR to merged (prUrl recorded), clears escalations, closes the sub-issue, and completes the PBI", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", state: "failed" })]);
    pbiStore.addEscalation(pbiId, {
      kind: "task_failed",
      subTaskKey: "t1",
      detail: "boom",
    });
    github.prState = { kind: "merged", url: "https://pr/1" };

    await markTaskDone(deps, pbiId, "t1");

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("merged");
    expect(after.subTasks[0].prUrl).toBe("https://pr/1");
    expect(after.escalations).toHaveLength(0);
    expect(github.prLookups).toEqual(["feature/100-t"]);
    expect(github.closedIssues).toEqual([100]);
    expect(after.status).toBe("completed");
  });

  it("moves a failed task without a merged PR to done_no_pr and completes the PBI", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", state: "failed" })]);
    github.prState = { kind: "closed", url: "https://pr/1" };

    await markTaskDone(deps, pbiId, "t1");

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("done_no_pr");
    expect(after.subTasks[0].prUrl).toBeNull();
    expect(after.status).toBe("completed");
  });

  it("falls back to done_no_pr when the github client is absent", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", state: "failed" })]);

    await markTaskDone({ ...deps, github: undefined }, pbiId, "t1");

    expect(pbiStore.get(pbiId)!.subTasks[0].state).toBe("done_no_pr");
  });

  it("dispatches dependent tasks after marking done (skipTask 同系の次発射)", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [
      rec({ key: "t1", state: "failed" }),
      rec({ key: "t2", issueNumber: 101, branch: null, dependsOn: ["t1"] }),
    ]);

    await markTaskDone(deps, pbiId, "t1");

    const after = pbiStore.get(pbiId)!;
    expect(after.status).toBe("executing");
    expect(after.subTasks[1].state).toBe("running");
    expect(jobStore.list()).toHaveLength(1);
  });

  it("rejects non-failed sub-tasks before touching GitHub", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", state: "running" })]);

    await expect(markTaskDone(deps, pbiId, "t1")).rejects.toThrow(
      /invalid sub-task transition: running -> done_no_pr/,
    );
    expect(github.prLookups).toHaveLength(0);
    expect(pbiStore.get(pbiId)!.subTasks[0].state).toBe("running");
  });

  it("rejects unknown pbi / sub-task keys", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", state: "failed" })]);

    await expect(markTaskDone(deps, "pbi-nope", "t1")).rejects.toThrow(
      /unknown pbi/,
    );
    await expect(markTaskDone(deps, pbiId, "t9")).rejects.toThrow(
      /unknown sub-task/,
    );
  });

  it("does not block completion when closeIssue fails (best-effort)", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", state: "failed" })]);
    github.closeIssueError = new Error("gh down");

    await markTaskDone(deps, pbiId, "t1");

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("done_no_pr");
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

  it("does not leave bogus task_failed escalations when jobStore emits synchronously (production wiring)", () => {
    // 本番では store.on("job", (job) => onJobUpdated(exec, job)) が常時配線されている。
    // scheduler.cancel() は同期的に "job" イベントを発火するため、cancelPbi が先に
    // PBI を cancelled にしておかないと、onJobUpdated が executing のままの PBI を
    // 見つけて task_failed の誤エスカレーションを積んでしまう。
    jobStore.on("job", (job) => onJobUpdated(deps, job));

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

    const after = pbiStore.get(pbiId)!;
    expect(after.status).toBe("cancelled");
    expect(
      after.escalations.filter((e) => e.kind === "task_failed"),
    ).toHaveLength(0);
    expect(after.subTasks[0].state).not.toBe("failed");
  });
});
