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
    {
      runJob: async (deps, jobId) => {
        deps.store.transition(jobId, "running");
      },
    },
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

  it("advances a running sub-task to in_review (with prUrl) when its job already finished done, without re-dispatching", () => {
    const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    const job = jobStore.create({
      repo: "r",
      issueNumber: 100,
      issueTitle: "t",
      branch: "feature/100-t",
    });
    jobStore.transition(job.id, "running");
    jobStore.transition(job.id, "done", {
      prUrl: "https://github.com/yonda/cockpit/pull/9",
    });
    pbiStore.setSubTasks(pbi.id, [rec({ key: "t1", jobId: job.id })]);

    reconcileOnBoot({ pbiStore, exec });

    const t1 = pbiStore.get(pbi.id)!.subTasks[0];
    expect(t1.state).toBe("in_review");
    expect(t1.prUrl).toBe("https://github.com/yonda/cockpit/pull/9");
    // 再発射されていない（PR が既にあるのに重複ジョブを作らない）
    expect(jobStore.list()).toHaveLength(1);
  });

  it("marks a running sub-task failed with a task_failed escalation when its job already finished failed, without auto-retrying", () => {
    const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    const job = jobStore.create({
      repo: "r",
      issueNumber: 100,
      issueTitle: "t",
      branch: "feature/100-t",
    });
    jobStore.transition(job.id, "running");
    jobStore.transition(job.id, "failed", { error: "boom" });
    pbiStore.setSubTasks(pbi.id, [rec({ key: "t1", jobId: job.id })]);

    reconcileOnBoot({ pbiStore, exec });

    const after = pbiStore.get(pbi.id)!;
    expect(after.subTasks[0].state).toBe("failed");
    expect(after.escalations.map((e) => e.kind)).toContain("task_failed");
    // 自動リトライしていない（新規ジョブが作られていない）
    expect(jobStore.list()).toHaveLength(1);
  });
});
