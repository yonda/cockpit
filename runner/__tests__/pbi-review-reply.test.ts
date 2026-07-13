// runner/__tests__/pbi-review-reply.test.ts
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
import type { PbiExecutorDeps } from "../pbi-executor";
import { fireReviewReply } from "../pbi-review-reply";

let jobsDir: string;
let pbisDir: string;
let jobStore: JobStore;
let pbiStore: PbiStore;
let deps: PbiExecutorDeps;

const rec = (over: Partial<SubTaskRecord>): SubTaskRecord => ({
  key: "t1", title: "t", goal: "", deliverable: "", acceptanceCriteria: [],
  dependsOn: [], state: "in_review", issueNumber: 100, jobId: "impl-1",
  branch: "feature/100-t", prUrl: "https://github.com/yonda/cockpit/pull/9",
  ...over,
});

beforeEach(() => {
  jobsDir = mkdtempSync(join(tmpdir(), "jobs-"));
  pbisDir = mkdtempSync(join(tmpdir(), "pbis-"));
  jobStore = new JobStore(jobsDir); jobStore.loadAll();
  pbiStore = new PbiStore(pbisDir); pbiStore.loadAll();
  const scheduler = new Scheduler(
    { store: jobStore, broker: new InputBroker(),
      commands: { run: async () => ({ stdout: "", stderr: "" }) },
      executor: { run: async () => ({ ok: true }) },
      registry: new RepoRegistry([]),
      resolveToken: () => "test-token" },
    { runJob: async (d, jobId) => { d.store.transition(jobId, "running"); } },
  );
  deps = { pbiStore, jobStore, scheduler };
});
afterEach(() => {
  rmSync(jobsDir, { recursive: true, force: true });
  rmSync(pbisDir, { recursive: true, force: true });
});

describe("fireReviewReply", () => {
  it("clears the review_comments escalation and launches a review-reply job on the sub-task branch", () => {
    const pbi = pbiStore.create({ repo: "yonda/cockpit", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    pbiStore.setSubTasks(pbi.id, [rec({ key: "t1" })]);
    pbiStore.addEscalation(pbi.id, {
      kind: "review_comments", subTaskKey: "t1", detail: "2 件",
    });

    fireReviewReply(deps, pbi.id, "t1");

    const after = pbiStore.get(pbi.id)!;
    const t1 = after.subTasks[0];
    expect(after.escalations.some((e) => e.kind === "review_comments")).toBe(false);
    expect(t1.state).toBe("in_review"); // state は保つ
    // 新しい review_reply ジョブが作られ、sub-task の jobId が付け替わっている
    const job = jobStore.get(t1.jobId!)!;
    expect(job.kind).toBe("review_reply");
    expect(job.issueNumber).toBe(100);
    expect(job.branch).toBe("feature/100-t");
    expect(t1.jobId).not.toBe("impl-1");
  });

  it("no-ops when the sub-task is not in_review", () => {
    const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    pbiStore.setSubTasks(pbi.id, [rec({ key: "t1", state: "running" })]);
    fireReviewReply(deps, pbi.id, "t1");
    expect(jobStore.list().filter((j) => j.kind === "review_reply")).toHaveLength(0);
  });

  it("no-ops when a review-reply job is already running for the sub-task", () => {
    const pbi = pbiStore.create({ repo: "yonda/cockpit", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    const running = jobStore.create({ repo: "yonda/cockpit", issueNumber: 100, issueTitle: "t", branch: "feature/100-t", kind: "review_reply" });
    jobStore.transition(running.id, "running");
    pbiStore.setSubTasks(pbi.id, [rec({ key: "t1", jobId: running.id })]);
    pbiStore.addEscalation(pbi.id, { kind: "review_comments", subTaskKey: "t1", detail: "2 件" });

    fireReviewReply(deps, pbi.id, "t1");

    // 二重発射しない: 新しい review_reply ジョブは作られず、エスカレーションも残る（誤消去しない）
    expect(jobStore.list().filter((j) => j.kind === "review_reply")).toHaveLength(1);
    expect(pbiStore.get(pbi.id)!.escalations.some((e) => e.kind === "review_comments")).toBe(true);
  });
});
