// runner/pbi-review-reply.ts
import type { PbiExecutorDeps } from "./pbi-executor";

/**
 * in_review の sub-task に付いた review_comments を解消し、その branch で
 * レビュー返信ジョブ (kind: review_reply) を発射する。sub-task の状態は
 * in_review のまま、jobId だけ返信ジョブに付け替える（UI が pendingInput を
 * 突き合わせられるように）。
 */
export function fireReviewReply(
  deps: PbiExecutorDeps,
  pbiId: string,
  key: string,
): void {
  const pbi = deps.pbiStore.get(pbiId);
  if (!pbi) return;
  const task = pbi.subTasks.find((t) => t.key === key);
  if (!task || task.state !== "in_review" || task.issueNumber == null) return;

  // 既に review-reply ジョブが走っている場合は二重発射しない（先行ジョブが孤児化するのを防ぐ）
  const current = task.jobId ? deps.jobStore.get(task.jobId) : undefined;
  if (current && ["queued", "running", "waiting_input"].includes(current.status)) return;

  // review_comments エスカレーションをクリア
  for (const e of pbi.escalations.filter(
    (e) => e.kind === "review_comments" && e.subTaskKey === key,
  )) {
    deps.pbiStore.clearEscalation(pbiId, e.id);
  }

  // 返信ジョブを作成（既存 worktree/branch を再利用する kind）
  const job = deps.jobStore.create({
    repo: pbi.repo,
    issueNumber: task.issueNumber,
    issueTitle: task.title,
    branch: task.branch ?? `feature/${task.issueNumber}-${key}`,
    kind: "review_reply",
  });
  // sub-task の jobId を付け替え（state は in_review のまま）
  deps.pbiStore.update(pbiId, {
    subTasks: deps.pbiStore
      .get(pbiId)!
      .subTasks.map((t) => (t.key === key ? { ...t, jobId: job.id } : t)),
  });
  deps.scheduler.poke();
}
