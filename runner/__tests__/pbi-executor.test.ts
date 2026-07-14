// runner/__tests__/pbi-executor.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Job } from "../../lib/jobs/types";
import type { SubTaskRecord } from "../../lib/pbi/types";
import type { GitHubClient } from "../github";
import { JobStore } from "../store";
import { PbiStore } from "../pbi-store";
import { RepoRegistry } from "../repo-registry";
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

/** 既定でエラーを投げるスタブ GitHubClient。必要なメソッドだけ差し替える。 */
const fakeGithub = (over: Partial<GitHubClient> = {}): GitHubClient => ({
  fetchIssue: async () => {
    throw new Error("not implemented");
  },
  createSubIssue: async () => {
    throw new Error("not implemented");
  },
  updateIssueBody: async () => {
    throw new Error("not implemented");
  },
  closeIssue: async () => {},
  prStateForBranch: async () => ({ kind: "none" }),
  searchAssignedOpenIssues: async () => [],
  ...over,
});

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

  it("moves the sub-task to in_review on job done and records the PR url", async () => {
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

    await onJobUpdated(deps, done);

    const t1 = pbiStore.get(pbi.id)!.subTasks[0];
    expect(t1.state).toBe("in_review");
    expect(t1.prUrl).toBe("https://github.com/yonda/cockpit/pull/9");
  });

  it("moves the sub-task to done_no_pr on a no-changes done job, without escalation, and closes the sub-issue", async () => {
    const closed: Array<{ repo: string; number: number }> = [];
    const github = fakeGithub({
      closeIssue: async (repo, number) => {
        closed.push({ repo, number });
      },
    });
    // t1（noChanges で完了）→ done_no_pr、後続 t2 が発射されることを確認する。
    const pbi = pbiStore.create({ repo: "r", issueNumber: 42, title: "P" });
    pbiStore.transition(pbi.id, "awaiting_approval");
    pbiStore.transition(pbi.id, "executing");
    pbiStore.setSubTasks(pbi.id, [
      rec({ key: "t1", issueNumber: 100, branch: "feature/100-t" }),
      rec({
        key: "t2",
        issueNumber: 101,
        branch: "feature/101-t",
        dependsOn: ["t1"],
      }),
    ]);
    dispatchReady(deps, pbi.id);
    const jobId = pbiStore.get(pbi.id)!.subTasks.find((t) => t.key === "t1")!
      .jobId!;
    const done = jobStore.transition(jobId, "done", { noChanges: true });

    await onJobUpdated({ ...deps, github }, done);

    const after = pbiStore.get(pbi.id)!;
    const t1 = after.subTasks.find((t) => t.key === "t1")!;
    const t2 = after.subTasks.find((t) => t.key === "t2")!;
    expect(t1.state).toBe("done_no_pr");
    expect(t1.prUrl).toBeNull();
    // task_failed エスカレーションは積まれない
    expect(after.escalations).toHaveLength(0);
    // 対応 sub-issue がクローズされる（merged 経路と同様）
    expect(closed).toEqual([{ repo: "r", number: 100 }]);
    // 依存していた後続タスクが発射される
    expect(t2.state).toBe("running");
    expect(t2.jobId).not.toBeNull();
  });

  it("completes the PBI when the only sub-task finishes with a no-changes done job", async () => {
    const pbi = setup(); // t1 のみ、running 状態
    const jobId = pbiStore.get(pbi.id)!.subTasks[0].jobId!;
    const done = jobStore.transition(jobId, "done", { noChanges: true });

    await onJobUpdated({ ...deps, github: fakeGithub() }, done);

    const after = pbiStore.get(pbi.id)!;
    expect(after.subTasks[0].state).toBe("done_no_pr");
    expect(after.status).toBe("completed");
  });

  it("marks the sub-task failed and escalates on job failure", async () => {
    const pbi = setup();
    const jobId = pbiStore.get(pbi.id)!.subTasks[0].jobId!;
    // setup() の dispatchReady で fake scheduler が既に queued→running 済み
    const failed = jobStore.transition(jobId, "failed", { error: "boom" });

    await onJobUpdated(deps, failed);

    const after = pbiStore.get(pbi.id)!;
    expect(after.subTasks[0].state).toBe("failed");
    expect(after.escalations.map((e) => e.kind)).toContain("task_failed");
    // noChanges でない失敗ジョブは従来どおり done_no_pr にしない
    expect(after.subTasks[0].state).not.toBe("done_no_pr");
  });

  it("keeps an in_review sub-task in_review when its (review-reply) job fails, adding an escalation", async () => {
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

    await onJobUpdated(deps, failed);

    const t1 = pbiStore.get(pbi.id)!.subTasks[0];
    expect(t1.state).toBe("in_review"); // failed にしない
    expect(pbiStore.get(pbi.id)!.escalations.map((e) => e.kind)).toContain("task_failed");
  });
});
