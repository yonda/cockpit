// runner/pbi-boot.ts
import { dispatchReady, type PbiExecutorDeps } from "./pbi-executor";
import type { PbiStore } from "./pbi-store";

export async function reconcileOnBoot(deps: {
  pbiStore: PbiStore;
  exec: PbiExecutorDeps;
}): Promise<void> {
  for (const pbi of deps.pbiStore.list()) {
    if (pbi.status !== "executing") continue;
    for (const task of pbi.subTasks) {
      if (task.state !== "running") continue;
      const job = task.jobId ? deps.exec.jobStore.get(task.jobId) : undefined;
      if (!job) {
        // 前回プロセスと共に消えたジョブ（記録も無い）→ 未着手に戻して再発射候補にする。
        // running -> pending は状態機械に無いため failed を経由する。
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "failed");
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "pending", {
          jobId: null,
        });
      } else if (job.status === "done") {
        // ランナー停止中に PR 作成まで終わっていた → in_review に進める。
        // ここで再発射すると同じ issue に対して重複ジョブ/PR を作ってしまう。
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "in_review", {
          prUrl: job.prUrl,
        });
      } else if (job.status === "failed" || job.status === "cancelled") {
        // 停止中に失敗/キャンセル済み → 仕様上、自動リトライはしない。エスカレーションのみ。
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "failed");
        deps.pbiStore.addEscalation(pbi.id, {
          kind: "task_failed",
          subTaskKey: task.key,
          detail: `runner 再起動時: ジョブが ${job.status} でした`,
        });
      }
      // job が queued/running/waiting_input で生存中 → 何もしない（running のまま）
    }
    await dispatchReady(deps.exec, pbi.id);
  }
}
