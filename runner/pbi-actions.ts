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
  deps.pbiStore.transitionSubTask(pbiId, key, "pending", { jobId: null });
  clearEscalationsFor(deps.pbiStore, pbiId, key);
  dispatchReady(deps, pbiId);
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

/**
 * 実成果がある failed sub-task を人間が明示的に完了として扱う。
 * branch の PR をフォールバック検索し、merged なら実態に合わせて merged
 * （prUrl 記録）、それ以外は done_no_pr へ遷移させる。
 */
export async function markTaskDone(
  deps: PbiExecutorDeps,
  pbiId: string,
  key: string,
): Promise<void> {
  const pbi = deps.pbiStore.get(pbiId);
  if (!pbi) throw new Error(`unknown pbi: ${pbiId}`);
  const task = pbi.subTasks.find((t) => t.key === key);
  if (!task) throw new Error(`unknown sub-task: ${key} (${pbiId})`);
  // failed 専用の回復操作。running -> done_no_pr は状態機械上は合法（差分なし
  // 完了）だが、実行中ジョブを孤児化させるため人間の完了操作としては gh 呼び出し
  // より前に拒否する。他の状態は transitionSubTask (canSubTaskTransition) でも弾かれる。
  if (task.state !== "failed") {
    throw new Error(
      `invalid sub-task transition: ${task.state} -> done_no_pr (${pbiId}/${key})`,
    );
  }

  let to: "merged" | "done_no_pr" = "done_no_pr";
  let patch: { prUrl?: string } = {};
  if (task.branch && deps.github) {
    const pr = await deps.github.prStateForBranch(pbi.repo, task.branch);
    if (pr.kind === "merged") {
      to = "merged";
      patch = { prUrl: pr.url };
    }
  }
  deps.pbiStore.transitionSubTask(pbiId, key, to, patch);
  clearEscalationsFor(deps.pbiStore, pbiId, key);

  // 完了扱いにした sub-issue は poller の merged 経路と同様にクローズする。
  // 失敗しても状態遷移や後続発射を止めない (best-effort)。
  if (task.issueNumber != null && deps.github) {
    try {
      await deps.github.closeIssue(pbi.repo, task.issueNumber);
    } catch (err) {
      console.error(
        `[pbi-actions] closeIssue failed (${pbi.repo}#${task.issueNumber}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const fresh = deps.pbiStore.get(pbiId)!;
  if (fresh.status === "executing" && isPbiComplete(fresh.subTasks)) {
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
