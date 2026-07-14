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

export async function retryTask(
  deps: PbiExecutorDeps,
  pbiId: string,
  key: string,
): Promise<void> {
  // jobId は null にせず残す。failed が誤判定（前ジョブがまだ稼働中）だった場合に
  // dispatchReady の発射前ガードが前ジョブの生存を確認して二重発射を防げるようにする。
  deps.pbiStore.transitionSubTask(pbiId, key, "pending");
  clearEscalationsFor(deps.pbiStore, pbiId, key);
  await dispatchReady(deps, pbiId);
}

export async function skipTask(
  deps: PbiExecutorDeps,
  pbiId: string,
  key: string,
): Promise<void> {
  deps.pbiStore.transitionSubTask(pbiId, key, "skipped");
  clearEscalationsFor(deps.pbiStore, pbiId, key);
  const pbi = deps.pbiStore.get(pbiId)!;
  if (pbi.status === "executing" && isPbiComplete(pbi.subTasks)) {
    deps.pbiStore.transition(pbiId, "completed");
  } else {
    await dispatchReady(deps, pbiId);
  }
}

export function pausePbi(store: PbiStore, pbiId: string): void {
  store.update(pbiId, { paused: true });
}

export async function resumePbi(
  deps: PbiExecutorDeps,
  pbiId: string,
): Promise<void> {
  deps.pbiStore.update(pbiId, { paused: false });
  await dispatchReady(deps, pbiId);
}

export function cancelPbi(deps: PbiExecutorDeps, pbiId: string): void {
  const pbi = deps.pbiStore.get(pbiId);
  if (!pbi) return;
  // 先に PBI を cancelled にしてから job を止める。
  // scheduler.cancel() は同期的に "job" イベントを発火し、それを購読する
  // onJobUpdated が pbi.status を見て早期リターンするため、順序を逆にすると
  // まだ executing の PBI に対して task_failed の誤エスカレーションが積まれる。
  deps.pbiStore.transition(pbiId, "cancelled");
  for (const t of pbi.subTasks) {
    if (t.jobId && t.state === "running") {
      deps.scheduler.cancel(t.jobId);
    }
  }
}
