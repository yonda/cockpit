// runner/pbi-boot.ts
import { dispatchReady, type PbiExecutorDeps } from "./pbi-executor";
import type { PbiStore } from "./pbi-store";

export function reconcileOnBoot(deps: {
  pbiStore: PbiStore;
  exec: PbiExecutorDeps;
}): void {
  for (const pbi of deps.pbiStore.list()) {
    if (pbi.status !== "executing") continue;
    for (const task of pbi.subTasks) {
      if (task.state !== "running") continue;
      const job = task.jobId ? deps.exec.jobStore.get(task.jobId) : undefined;
      const alive =
        job && ["queued", "running", "waiting_input"].includes(job.status);
      if (!alive) {
        // 前回プロセスと共に消えたジョブ → 未着手に戻して再発射候補にする。
        // running -> pending は状態機械に無いため failed を経由する。
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "failed");
        deps.pbiStore.transitionSubTask(pbi.id, task.key, "pending", {
          jobId: null,
        });
      }
    }
    dispatchReady(deps.exec, pbi.id);
  }
}
