// runner/pbi-actions.ts
import type { PbiStore } from "./pbi-store";
import { dispatchReady, type PbiExecutorDeps } from "./pbi-executor";
import { isPbiComplete } from "./pbi-graph";

function clearEscalationsFor(
  store: PbiStore,
  pbiId: string,
  key: string,
): void {
  const pbi = store.get(pbiId);
  if (!pbi) return;
  for (const e of pbi.escalations.filter((e) => e.subTaskKey === key)) {
    store.clearEscalation(pbiId, e.id);
  }
}

export function retryTask(
  deps: PbiExecutorDeps,
  pbiId: string,
  key: string,
): void {
  clearEscalationsFor(deps.pbiStore, pbiId, key);
  const pbi = deps.pbiStore.get(pbiId);
  if (!pbi) return;
  const task = pbi.subTasks.find((t) => t.key === key);
  if (!task || task.issueNumber == null) return;
  // sub-task の状態機械は failed -> pending を許可していない
  // （failed: ["running", "skipped"]）ため、dispatchReady の
  // pending 経由ではなく、直接 running へ遷移させてジョブを発射する。
  const job = deps.jobStore.create({
    repo: pbi.repo,
    issueNumber: task.issueNumber,
    issueTitle: task.title,
    branch: task.branch ?? `feature/${task.issueNumber}-${task.key}`,
  });
  deps.pbiStore.transitionSubTask(pbiId, key, "running", { jobId: job.id });
  deps.scheduler.poke();
}

export function skipTask(
  deps: PbiExecutorDeps,
  pbiId: string,
  key: string,
): void {
  deps.pbiStore.transitionSubTask(pbiId, key, "skipped");
  clearEscalationsFor(deps.pbiStore, pbiId, key);
  const pbi = deps.pbiStore.get(pbiId)!;
  if (pbi.status === "executing" && isPbiComplete(pbi.subTasks)) {
    deps.pbiStore.transition(pbiId, "completed");
  } else {
    dispatchReady(deps, pbiId);
  }
}

export function pausePbi(store: PbiStore, pbiId: string): void {
  store.update(pbiId, { paused: true });
}

export function resumePbi(deps: PbiExecutorDeps, pbiId: string): void {
  deps.pbiStore.update(pbiId, { paused: false });
  dispatchReady(deps, pbiId);
}

export function cancelPbi(deps: PbiExecutorDeps, pbiId: string): void {
  const pbi = deps.pbiStore.get(pbiId);
  if (!pbi) return;
  for (const t of pbi.subTasks) {
    if (t.jobId && ["running"].includes(t.state)) {
      deps.scheduler.cancel(t.jobId);
    }
  }
  deps.pbiStore.transition(pbiId, "cancelled");
}
