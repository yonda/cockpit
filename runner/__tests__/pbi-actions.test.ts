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
