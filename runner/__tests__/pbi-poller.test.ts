// runner/__tests__/pbi-poller.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubClient, PrState } from "../github";
import type { SubTaskRecord } from "../../lib/pbi/types";
import { JobStore } from "../store";
import { PbiStore } from "../pbi-store";
import { RepoRegistry } from "../repo-registry";
import { Scheduler } from "../scheduler";
import { InputBroker } from "../input-broker";
import { pollOnce } from "../pbi-poller";
import type { PbiExecutorDeps } from "../pbi-executor";

let jobsDir: string;
let pbisDir: string;
let pbiStore: PbiStore;
let exec: PbiExecutorDeps;

const rec = (over: Partial<SubTaskRecord>): SubTaskRecord => ({
  key: "t1",
  title: "t",
  goal: "",
  deliverable: "",
  acceptanceCriteria: [],
  dependsOn: [],
  state: "in_review",
  issueNumber: 100,
  jobId: "job-1",
  branch: "feature/100-t",
  prUrl: "https://github.com/yonda/cockpit/pull/9",
  ...over,
});

class FakeGitHub implements GitHubClient {
  closed: number[] = [];
  prStates: Record<string, PrState> = {};
  throwFor = new Set<string>();
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
    if (this.throwFor.has(branch)) throw new Error("gh api down");
    return this.prStates[branch] ?? { kind: "none" };
  }
  async searchAssignedOpenIssues() {
    return [];
  }
}

const executing = () => {
  const pbi = pbiStore.create({ repo: "yonda/cockpit", issueNumber: 42, title: "P" });
  pbiStore.transition(pbi.id, "awaiting_approval");
  pbiStore.transition(pbi.id, "executing");
  return pbi.id;
};

beforeEach(() => {
  jobsDir = mkdtempSync(join(tmpdir(), "jobs-"));
  pbisDir = mkdtempSync(join(tmpdir(), "pbis-"));
  const jobStore = new JobStore(jobsDir);
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
  exec = { pbiStore, jobStore, scheduler };
});
afterEach(() => {
  rmSync(jobsDir, { recursive: true, force: true });
  rmSync(pbisDir, { recursive: true, force: true });
});

describe("pollOnce", () => {
  it("closes the sub-issue and completes the PBI when the only PR is merged", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", branch: "feature/100-t" })]);
    const github = new FakeGitHub();
    github.prStates["feature/100-t"] = {
      kind: "merged",
      url: "https://github.com/yonda/cockpit/pull/9",
    };

    await pollOnce({ pbiStore, github, exec });

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("merged");
    expect(github.closed).toEqual([100]);
    expect(after.status).toBe("completed");
  });

  it("escalates pr_closed_unmerged when the PR was closed without merge", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", branch: "feature/100-t" })]);
    const github = new FakeGitHub();
    github.prStates["feature/100-t"] = {
      kind: "closed",
      url: "https://github.com/yonda/cockpit/pull/9",
    };

    await pollOnce({ pbiStore, github, exec });

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("failed");
    expect(after.escalations.map((e) => e.kind)).toContain("pr_closed_unmerged");
  });

  it("escalates review_comments once while the PR stays open", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [rec({ key: "t1", branch: "feature/100-t" })]);
    const github = new FakeGitHub();
    github.prStates["feature/100-t"] = {
      kind: "open",
      url: "https://github.com/yonda/cockpit/pull/9",
      reviewCommentCount: 2,
    };

    await pollOnce({ pbiStore, github, exec });
    await pollOnce({ pbiStore, github, exec }); // 2 回目は二重通知しない

    const escs = pbiStore
      .get(pbiId)!
      .escalations.filter((e) => e.kind === "review_comments");
    expect(escs).toHaveLength(1);
    expect(pbiStore.get(pbiId)!.subTasks[0].state).toBe("in_review");
  });

  it("recovers a failed sub-task to merged when its branch has a merged PR", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [
      rec({ key: "t1", state: "failed", jobId: null, prUrl: null }),
    ]);
    pbiStore.addEscalation(pbiId, {
      kind: "task_failed",
      subTaskKey: "t1",
      detail: "ジョブが failed で終了しました",
    });
    const github = new FakeGitHub();
    github.prStates["feature/100-t"] = {
      kind: "merged",
      url: "https://github.com/yonda/cockpit/pull/9",
    };

    await pollOnce({ pbiStore, github, exec });

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("merged");
    expect(after.subTasks[0].prUrl).toBe(
      "https://github.com/yonda/cockpit/pull/9",
    );
    expect(github.closed).toEqual([100]);
    expect(after.escalations.filter((e) => e.kind === "task_failed")).toHaveLength(0);
    expect(after.status).toBe("completed");
  });

  it("recovers a failed sub-task to in_review when its branch has an open PR", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [
      rec({ key: "t1", state: "failed", jobId: null, prUrl: null }),
    ]);
    pbiStore.addEscalation(pbiId, {
      kind: "task_failed",
      subTaskKey: "t1",
      detail: "ジョブが failed で終了しました",
    });
    const github = new FakeGitHub();
    github.prStates["feature/100-t"] = {
      kind: "open",
      url: "https://github.com/yonda/cockpit/pull/9",
      reviewCommentCount: 0,
    };

    await pollOnce({ pbiStore, github, exec });

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("in_review");
    expect(after.subTasks[0].prUrl).toBe(
      "https://github.com/yonda/cockpit/pull/9",
    );
    expect(after.escalations.filter((e) => e.kind === "task_failed")).toHaveLength(0);
    expect(github.closed).toEqual([]);

    // 回復後は既存の in_review 監視に乗る: マージされれば merged へ
    github.prStates["feature/100-t"] = {
      kind: "merged",
      url: "https://github.com/yonda/cockpit/pull/9",
    };
    await pollOnce({ pbiStore, github, exec });
    expect(pbiStore.get(pbiId)!.subTasks[0].state).toBe("merged");
    expect(github.closed).toEqual([100]);
  });

  it("does not recover a failed sub-task when its branch has no PR or only an unmerged closed PR", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [
      rec({ key: "t1", state: "failed", jobId: null, prUrl: null }),
      rec({
        key: "t2",
        state: "failed",
        jobId: null,
        prUrl: null,
        issueNumber: 101,
        branch: "feature/101-t",
      }),
    ]);
    pbiStore.addEscalation(pbiId, {
      kind: "task_failed",
      subTaskKey: "t1",
      detail: "ジョブが failed で終了しました",
    });
    const github = new FakeGitHub();
    // t1 のブランチには PR なし ({ kind: "none" })、t2 は unmerged closed のみ
    github.prStates["feature/101-t"] = {
      kind: "closed",
      url: "https://github.com/yonda/cockpit/pull/10",
    };

    await pollOnce({ pbiStore, github, exec });

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks[0].state).toBe("failed");
    expect(after.subTasks[1].state).toBe("failed");
    expect(after.subTasks[0].prUrl).toBeNull();
    expect(after.subTasks[1].prUrl).toBeNull();
    expect(github.closed).toEqual([]);
    // エスカレーションは残る（回復していないので取り下げない）
    expect(after.escalations.filter((e) => e.kind === "task_failed")).toHaveLength(1);
  });

  it("dispatches a dependent pending sub-task once the failed one recovers to merged", async () => {
    const pbiId = executing();
    pbiStore.setSubTasks(pbiId, [
      rec({ key: "t3", state: "failed", jobId: null, prUrl: null }),
      rec({
        key: "t4",
        state: "pending",
        jobId: null,
        prUrl: null,
        branch: null,
        issueNumber: 104,
        dependsOn: ["t3"],
      }),
    ]);
    const github = new FakeGitHub();
    github.prStates["feature/100-t"] = {
      kind: "merged",
      url: "https://github.com/yonda/cockpit/pull/9",
    };

    await pollOnce({ pbiStore, github, exec });

    const after = pbiStore.get(pbiId)!;
    expect(after.subTasks.find((t) => t.key === "t3")!.state).toBe("merged");
    // t3 の回復で依存が満たされ、既存の dispatchReady 経路で t4 が発射される
    const t4 = after.subTasks.find((t) => t.key === "t4")!;
    expect(t4.state).toBe("running");
    expect(t4.jobId).not.toBeNull();
  });

  it("isolates a per-PBI failure so other PBIs still get processed", async () => {
    const pbi1 = executing();
    pbiStore.setSubTasks(pbi1, [rec({ key: "t1", branch: "feature/100-t" })]);

    const pbi2 = pbiStore.create({
      repo: "yonda/cockpit",
      issueNumber: 43,
      title: "Q",
    });
    pbiStore.transition(pbi2.id, "awaiting_approval");
    pbiStore.transition(pbi2.id, "executing");
    pbiStore.setSubTasks(pbi2.id, [
      rec({ key: "t1", branch: "feature/200-t", issueNumber: 200 }),
    ]);

    const github = new FakeGitHub();
    github.throwFor.add("feature/100-t"); // pbi1 は gh API 呼び出しで例外
    github.prStates["feature/200-t"] = {
      kind: "closed",
      url: "https://github.com/yonda/cockpit/pull/10",
    };

    await pollOnce({ pbiStore, github, exec });

    // pbi1: 例外が握りつぶされ、状態は変化しない（次周期で再試行される）
    expect(pbiStore.get(pbi1)!.subTasks[0].state).toBe("in_review");
    // pbi2: pbi1 の失敗に巻き込まれず処理が続行される
    const after2 = pbiStore.get(pbi2.id)!;
    expect(after2.subTasks[0].state).toBe("failed");
    expect(after2.escalations.map((e) => e.kind)).toContain(
      "pr_closed_unmerged",
    );
  });
});
