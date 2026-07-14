import { runDecomposition, type DecomposeDeps } from "./decompose";
import { materializeSubIssues, subTaskBranch } from "./pbi-subissues";
import { validateDependencies } from "./pbi-graph";
import { subIssueBody } from "./github";
import type { GitHubClient } from "./github";
import type { PbiStore } from "./pbi-store";
import { type SubTask, type SubTaskRecord } from "../lib/pbi/types";

export type LifecycleDeps = DecomposeDeps & {
  store: PbiStore;
  github: GitHubClient;
};

const MAX_DECOMPOSITION_ATTEMPTS = 5;

async function decomposeInto(
  deps: LifecycleDeps,
  pbiId: string,
  signal: AbortSignal,
  priorTasks?: SubTask[],
  feedback?: string,
): Promise<void> {
  const pbi = deps.store.get(pbiId);
  if (!pbi) throw new Error(`unknown pbi: ${pbiId}`);

  const attempts = pbi.decompositionAttempts + 1;
  deps.store.update(pbiId, { decompositionAttempts: attempts });
  if (attempts > MAX_DECOMPOSITION_ATTEMPTS) {
    deps.store.transition(pbiId, "failed", {
      error: `分解のやり直しが上限 (${MAX_DECOMPOSITION_ATTEMPTS}) を超えました`,
    });
    return;
  }

  const { title, body } = await deps.github.fetchIssue(
    pbi.repo,
    pbi.issueNumber,
  );
  const result = await runDecomposition(deps, {
    repo: pbi.repo,
    issueNumber: pbi.issueNumber,
    title,
    body,
    priorTasks,
    feedback,
    signal,
  });

  if (!result.ok) {
    deps.store.transition(pbiId, "failed", { error: result.error });
    return;
  }
  const depError = validateDependencies(
    result.tasks.map((t) => ({
      ...t,
      state: "pending" as const,
      issueNumber: null,
      jobId: null,
      branch: null,
      prUrl: null,
    })),
  );
  if (depError) {
    deps.store.transition(pbiId, "failed", { error: depError });
    return;
  }

  let records: SubTaskRecord[];
  if (priorTasks) {
    // 再分解: 既存 proposed sub-issue の本文を上書きし、新規ぶんは作成
    records = await reviseSubIssues(deps, pbiId, result.tasks);
  } else {
    records = await materializeSubIssues(
      deps.github,
      pbi.repo,
      pbi.issueNumber,
      result.tasks,
    );
  }
  deps.store.setSubTasks(pbiId, records);
  deps.store.transition(pbiId, "awaiting_approval");
  deps.store.addEscalation(pbiId, {
    kind: "decomposition_approval",
    subTaskKey: null,
    detail: `${records.length} タスクの分解案を承認してください`,
  });
}

async function reviseSubIssues(
  deps: LifecycleDeps,
  pbiId: string,
  tasks: SubTask[],
): Promise<SubTaskRecord[]> {
  const pbi = deps.store.get(pbiId)!;
  const existingByKey = new Map(pbi.subTasks.map((t) => [t.key, t]));
  const records: SubTaskRecord[] = [];
  for (const task of tasks) {
    const existing = existingByKey.get(task.key);
    if (existing?.issueNumber != null) {
      await deps.github.updateIssueBody(
        pbi.repo,
        existing.issueNumber,
        subIssueBody(task, true),
      );
      records.push({
        ...existing,
        ...task,
        state: "pending",
      });
    } else {
      const { number } = await deps.github.createSubIssue(
        pbi.repo,
        pbi.issueNumber,
        task,
      );
      records.push({
        ...task,
        state: "pending",
        issueNumber: number,
        jobId: null,
        branch: subTaskBranch(number, task.title),
        prUrl: null,
      });
    }
  }
  return records;
}

export async function startDecomposition(
  deps: LifecycleDeps,
  pbiId: string,
  signal: AbortSignal,
): Promise<void> {
  await decomposeInto(deps, pbiId, signal);
}

export async function reviseDecomposition(
  deps: LifecycleDeps,
  pbiId: string,
  feedback: string,
  signal: AbortSignal,
): Promise<void> {
  const pbi = deps.store.get(pbiId);
  if (!pbi) throw new Error(`unknown pbi: ${pbiId}`);
  deps.store.transition(pbiId, "decomposing");
  // decomposition_approval エスカレーションを消す
  for (const e of pbi.escalations.filter(
    (e) => e.kind === "decomposition_approval",
  )) {
    deps.store.clearEscalation(pbiId, e.id);
  }
  await decomposeInto(deps, pbiId, signal, pbi.subTasks, feedback);
}

export async function approveDecomposition(
  deps: LifecycleDeps,
  pbiId: string,
): Promise<void> {
  const pbi = deps.store.get(pbiId);
  if (!pbi) throw new Error(`unknown pbi: ${pbiId}`);
  if (pbi.status !== "awaiting_approval") {
    throw new Error(
      `cannot approve pbi in status ${pbi.status} (${pbiId})`,
    );
  }
  // 承認をまず同期的に確定する（awaiting_approval -> executing）。issue body 更新
  // （await を挟む）より前に遷移することで、並行 approve の TOCTOU を閉じる。
  // 遷移を末尾に置くと、2 つの approve が共に「まだ awaiting_approval」を観測して
  // どちらも本体に進み、2 個目が executing -> executing の不正遷移で throw →
  // fire-and-forget チェーンの .catch(failPbiSafely) が実行中の PBI を failed に
  // 落としてしまう。二重承認の 2 回目は pbi-server の pbi.approve ハンドラの
  // 同期ガードで弾く（この関数に到達する前に error を返す）。
  deps.store.transition(pbiId, "executing");
  for (const t of pbi.subTasks) {
    if (t.issueNumber != null) {
      await deps.github.updateIssueBody(
        pbi.repo,
        t.issueNumber,
        subIssueBody(t, false), // proposed マーカー無し
      );
    }
  }
  for (const e of pbi.escalations.filter(
    (e) => e.kind === "decomposition_approval",
  )) {
    deps.store.clearEscalation(pbiId, e.id);
  }
}

export async function rejectDecomposition(
  deps: LifecycleDeps,
  pbiId: string,
): Promise<void> {
  deps.store.transition(pbiId, "cancelled");
}
