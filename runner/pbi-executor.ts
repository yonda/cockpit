// runner/pbi-executor.ts
import type { Job } from "../lib/jobs/types";
import type { JobStore } from "./store";
import type { PbiStore } from "./pbi-store";
import type { Scheduler } from "./scheduler";
import { readySubTasks } from "./pbi-graph";
import { isPbiComplete } from "./pbi-graph";

export type PbiExecutorDeps = {
  pbiStore: PbiStore;
  jobStore: JobStore;
  scheduler: Scheduler;
};

export function dispatchReady(deps: PbiExecutorDeps, pbiId: string): void {
  const pbi = deps.pbiStore.get(pbiId);
  if (!pbi || pbi.status !== "executing" || pbi.paused) return;

  for (const task of readySubTasks(pbi.subTasks)) {
    if (task.issueNumber == null) continue; // sub-issue 未作成はスキップ（防御）
    const job = deps.jobStore.create({
      repo: pbi.repo,
      issueNumber: task.issueNumber,
      issueTitle: task.title,
      branch: task.branch ?? `feature/${task.issueNumber}-${task.key}`,
    });
    deps.pbiStore.transitionSubTask(pbiId, task.key, "running", {
      jobId: job.id,
    });
  }
  deps.scheduler.poke();
}

export function onJobUpdated(deps: PbiExecutorDeps, job: Job): void {
  // jobId 一致の sub-task を持つ PBI を探す
  const pbi = deps.pbiStore
    .list()
    .find((p) => p.subTasks.some((t) => t.jobId === job.id));
  if (!pbi) return;
  // cancelPbi 等で PBI が既に非 executing に遷移した後の遅延イベントは無視する
  // （例: job のキャンセルが同期的に "job" を発火し、cancelled 済みの PBI に
  // 対して task_failed の誤エスカレーションが積まれるのを防ぐ）。
  if (pbi.status !== "executing") return;
  const task = pbi.subTasks.find((t) => t.jobId === job.id);
  if (!task) return;

  if (job.status === "done" && task.state === "running") {
    deps.pbiStore.transitionSubTask(pbi.id, task.key, "in_review", {
      prUrl: job.prUrl,
    });
  } else if (
    (job.status === "failed" || job.status === "cancelled") &&
    task.state === "running"
  ) {
    // 実装ジョブの失敗 → sub-task を failed にしてエスカレーション
    deps.pbiStore.transitionSubTask(pbi.id, task.key, "failed");
    deps.pbiStore.addEscalation(pbi.id, {
      kind: "task_failed",
      subTaskKey: task.key,
      detail: job.error ?? `ジョブが ${job.status} で終了しました`,
    });
  } else if (
    (job.status === "failed" || job.status === "cancelled") &&
    task.state === "in_review"
  ) {
    // レビュー返信ジョブの失敗 → PR は生きているので sub-task は in_review のまま、通知だけ
    deps.pbiStore.addEscalation(pbi.id, {
      kind: "task_failed",
      subTaskKey: task.key,
      detail: `レビュー対応ジョブが ${job.status} で終了しました: ${job.error ?? ""}`,
    });
  }
  // done かつ in_review（返信ジョブ完了）は無変化（ポーラーが PR を追う）

  // PBI 完了判定 → もしくは次の発射
  const fresh = deps.pbiStore.get(pbi.id)!;
  if (isPbiComplete(fresh.subTasks) && fresh.status === "executing") {
    deps.pbiStore.transition(pbi.id, "completed");
  } else {
    dispatchReady(deps, pbi.id);
  }
}
