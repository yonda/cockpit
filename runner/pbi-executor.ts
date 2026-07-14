// runner/pbi-executor.ts
import type { Job } from "../lib/jobs/types";
import type { GitHubClient, PrState } from "./github";
import type { JobStore } from "./store";
import type { PbiStore } from "./pbi-store";
import type { Scheduler } from "./scheduler";
import { readySubTasks } from "./pbi-graph";
import { isPbiComplete } from "./pbi-graph";

export type PbiExecutorDeps = {
  pbiStore: PbiStore;
  jobStore: JobStore;
  scheduler: Scheduler;
  /**
   * done_no_pr / merged 整合時に対応する sub-issue をクローズし、発射前ガードで
   * branch の既存 PR を検索するための GitHub クライアント。未指定なら
   * close と PR ガードをスキップする（ジョブ稼働中ガードは常に効く）。
   */
  github?: GitHubClient;
};

/** 発射前ガード用の PR 検索。github 未指定・検索失敗時は null（= ガードせず発射）。 */
async function prStateSafe(
  deps: PbiExecutorDeps,
  repo: string,
  branch: string,
): Promise<PrState | null> {
  if (!deps.github) return null;
  try {
    return await deps.github.prStateForBranch(repo, branch);
  } catch (err) {
    // GitHub 一時障害で PBI 全体の進行を止めない（従来どおり発射する）
    console.error(
      `[pbi-executor] prStateForBranch failed (${repo} ${branch}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export async function dispatchReady(
  deps: PbiExecutorDeps,
  pbiId: string,
): Promise<void> {
  const pbi = deps.pbiStore.get(pbiId);
  if (!pbi || pbi.status !== "executing" || pbi.paused) return;

  for (const task of readySubTasks(pbi.subTasks)) {
    if (task.issueNumber == null) continue; // sub-issue 未作成はスキップ（防御）
    const branch = task.branch ?? `feature/${task.issueNumber}-${task.key}`;

    // 発射前ガード 1: 前 jobId のジョブがまだ稼働中なら再発射しない
    // （failed の誤判定 → retry で作業中エージェントのブランチに二重発射する事故の防止。
    //   fireReviewReply の二重発射ガードと同じ判定）。
    const prev = task.jobId ? deps.jobStore.get(task.jobId) : undefined;
    if (prev && ["queued", "running", "waiting_input"].includes(prev.status)) {
      continue;
    }

    // 発射前ガード 2: branch に既存 PR があれば job を作らず PR の実態へ整合させる
    const pr = await prStateSafe(deps, pbi.repo, branch);
    if (pr?.kind === "open") {
      deps.pbiStore.transitionSubTask(pbiId, task.key, "in_review", {
        prUrl: pr.url,
        branch,
      });
      continue;
    }
    if (pr?.kind === "merged") {
      // poller の merged 経路と同様に対応 sub-issue をクローズする。close 失敗で
      // 整合や他タスクの発射が止まらないよう best-effort。
      try {
        await deps.github!.closeIssue(pbi.repo, task.issueNumber);
      } catch (err) {
        console.error(
          `[pbi-executor] closeIssue failed (${pbi.repo}#${task.issueNumber}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      deps.pbiStore.transitionSubTask(pbiId, task.key, "merged", {
        prUrl: pr.url,
        branch,
      });
      continue;
    }

    const job = deps.jobStore.create({
      repo: pbi.repo,
      issueNumber: task.issueNumber,
      issueTitle: task.title,
      branch,
    });
    deps.pbiStore.transitionSubTask(pbiId, task.key, "running", {
      jobId: job.id,
    });
  }

  // merged への整合で PBI が完了し得る（例: 残り 1 件の retry 対象が実は merged だった）
  const fresh = deps.pbiStore.get(pbiId)!;
  if (fresh.status === "executing" && isPbiComplete(fresh.subTasks)) {
    deps.pbiStore.transition(pbiId, "completed");
    return;
  }
  deps.scheduler.poke();
}

export async function onJobUpdated(
  deps: PbiExecutorDeps,
  job: Job,
): Promise<void> {
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

  if (job.status === "done" && task.state === "running" && job.noChanges) {
    // PR なし完了 → in_review を経由せず done_no_pr（完了系終端）へ。
    // failed 経由の task_failed を積まないので同一結論のリトライループが起きない。
    deps.pbiStore.transitionSubTask(pbi.id, task.key, "done_no_pr");
    // merged 時（poller）と同様に対応 sub-issue をクローズする。onJobUpdated は
    // 再試行されないため、close 失敗で状態遷移や後続発射が止まらないよう best-effort。
    if (task.issueNumber != null && deps.github) {
      try {
        await deps.github.closeIssue(pbi.repo, task.issueNumber);
      } catch (err) {
        console.error(
          `[pbi-executor] closeIssue failed (${pbi.repo}#${task.issueNumber}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } else if (job.status === "done" && task.state === "running") {
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
    await dispatchReady(deps, pbi.id);
  }
}
