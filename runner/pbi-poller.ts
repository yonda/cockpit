// runner/pbi-poller.ts
import type { GitHubClient } from "./github";
import type { PbiStore } from "./pbi-store";
import { dispatchReady, type PbiExecutorDeps } from "./pbi-executor";
import { isPbiComplete } from "./pbi-graph";

type PollDeps = {
  pbiStore: PbiStore;
  github: GitHubClient;
  exec: PbiExecutorDeps;
};

/** 回復した sub-task に積まれていた task_failed エスカレーションを取り下げる。 */
function clearTaskFailedEscalations(
  store: PbiStore,
  pbiId: string,
  key: string,
): void {
  const pbi = store.get(pbiId);
  if (!pbi) return;
  for (const e of pbi.escalations) {
    if (e.kind === "task_failed" && e.subTaskKey === key) {
      store.clearEscalation(pbiId, e.id);
    }
  }
}

export async function pollOnce(deps: PollDeps): Promise<void> {
  for (const pbi of deps.pbiStore.list()) {
    if (pbi.status !== "executing") continue;
    try {
      for (const task of pbi.subTasks) {
        if (!task.branch) continue;

        if (task.state === "in_review") {
          const pr = await deps.github.prStateForBranch(pbi.repo, task.branch);

          if (pr.kind === "merged") {
            if (task.issueNumber != null) {
              await deps.github.closeIssue(pbi.repo, task.issueNumber);
            }
            deps.pbiStore.transitionSubTask(pbi.id, task.key, "merged", {
              prUrl: pr.url,
            });
          } else if (pr.kind === "closed") {
            deps.pbiStore.transitionSubTask(pbi.id, task.key, "failed");
            deps.pbiStore.addEscalation(pbi.id, {
              kind: "pr_closed_unmerged",
              subTaskKey: task.key,
              detail: `PR がマージされずクローズされました: ${pr.url}`,
            });
          } else if (pr.kind === "open" && pr.reviewCommentCount > 0) {
            const alreadyNotified = pbi.escalations.some(
              (e) => e.kind === "review_comments" && e.subTaskKey === task.key,
            );
            if (!alreadyNotified) {
              deps.pbiStore.addEscalation(pbi.id, {
                kind: "review_comments",
                subTaskKey: task.key,
                detail: `レビューコメントが ${pr.reviewCommentCount} 件付いています: ${pr.url}`,
              });
            }
          }
        } else if (task.state === "failed") {
          // prUrl/jobId の記録に依存せず、ブランチ名の PR フォールバック検索で
          // failed のまま取り残された sub-task を実態（open/merged）に合わせて回復する。
          const pr = await deps.github.prStateForBranch(pbi.repo, task.branch);

          if (pr.kind === "merged") {
            if (task.issueNumber != null) {
              await deps.github.closeIssue(pbi.repo, task.issueNumber);
            }
            deps.pbiStore.transitionSubTask(pbi.id, task.key, "merged", {
              prUrl: pr.url,
            });
            clearTaskFailedEscalations(deps.pbiStore, pbi.id, task.key);
          } else if (pr.kind === "open") {
            // 以後は既存の in_review 監視（マージ検知・レビューコメント検知）に乗る
            deps.pbiStore.transitionSubTask(pbi.id, task.key, "in_review", {
              prUrl: pr.url,
            });
            clearTaskFailedEscalations(deps.pbiStore, pbi.id, task.key);
          }
          // none / closed (unmerged) は誤回復しないため状態を変えない
        }
      }

      const fresh = deps.pbiStore.get(pbi.id)!;
      if (fresh.status === "executing" && isPbiComplete(fresh.subTasks)) {
        deps.pbiStore.transition(pbi.id, "completed");
      } else if (fresh.status === "executing") {
        await dispatchReady(deps.exec, pbi.id);
      }
    } catch (err) {
      // 1 PBI のポーリング失敗（gh API エラー等）で他の PBI の処理を止めない
      console.error(
        `[pbi-poller] ${pbi.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function startPoller(
  deps: PollDeps,
  intervalMs: number,
): { stop: () => void } {
  // 前回のポーリングが intervalMs より長引いた場合に二重起動しないためのガード
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void pollOnce(deps)
      .catch(() => {
        // ポーリングの一時失敗は握りつぶす（次周期で再試行）
      })
      .finally(() => {
        polling = false;
      });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
