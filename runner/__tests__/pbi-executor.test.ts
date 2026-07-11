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
    { runJob: async (deps, jobId) => { deps.store.transition(jobId, "running"); } },
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
    // setup() の dispatchReady で fake scheduler が既に queued→running 済み
    const job = { ...jobStore.get(jobId)! };
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
    // setup() の dispatchReady で fake scheduler が既に queued→running 済み
    const failed = jobStore.transition(jobId, "failed", { error: "boom" });

    onJobUpdated(deps, failed);

    const after = pbiStore.get(pbi.id)!;
    expect(after.subTasks[0].state).toBe("failed");
    expect(after.escalations.map((e) => e.kind)).toContain("task_failed");
  });

  it("keeps an in_review sub-task in_review when its (review-reply) job fails, adding an escalation", () => {
    const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    // sub-task を in_review にし、レビュー返信ジョブ (別 job) を紐付ける
    pbiStore.setSubTasks(pbi.id, [
      rec({ key: "t1", state: "in_review", jobId: "reply-1", prUrl: "u" }),
    ]);
    const replyJob = jobStore.create({
      repo: "r", issueNumber: 100, issueTitle: "t", branch: "feature/100-t",
      kind: "review_reply",
    });
    // 紐付けを reply job に付け替え（fireReviewReply が行う操作の代替）
    pbiStore.update(pbi.id, {
      subTasks: pbiStore.get(pbi.id)!.subTasks.map((t) =>
        t.key === "t1" ? { ...t, jobId: replyJob.id } : t,
      ),
    });
    jobStore.transition(replyJob.id, "running");
    const failed = jobStore.transition(replyJob.id, "failed", { error: "reply boom" });

    onJobUpdated(deps, failed);

    const t1 = pbiStore.get(pbi.id)!.subTasks[0];
    expect(t1.state).toBe("in_review"); // failed にしない
    expect(pbiStore.get(pbi.id)!.escalations.map((e) => e.kind)).toContain("task_failed");
  });
});
