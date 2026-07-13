import { homedir } from "node:os";
import { join } from "node:path";

// ---- 定数 -------------------------------------------------------------

export const PBIS_DIR =
  process.env.RUNNER_PBIS_DIR ?? join(homedir(), ".cache", "cockpit", "pbis");

export const PBI_POLL_INTERVAL_MS = Number(
  process.env.PBI_POLL_INTERVAL_MS ?? 90_000,
);

/** sub-issue 本文の冒頭に置く「確定前」マーカー。承認時に取り除く。 */
export const SUBTASK_MARKER = "<!-- cockpit:proposed -->";

/**
 * ジョブ出力に現れる「差分なしで完了した」ことを示すマーカー。
 * これを検知したタスクは PR を作らず done_no_pr へ遷移する。
 */
export const NO_CHANGES_MARKER = "<!-- cockpit:no-changes -->";

// ---- PBI 状態機械 -------------------------------------------------------

export type PbiStatus =
  | "decomposing"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

const PBI_TRANSITIONS: Record<PbiStatus, readonly PbiStatus[]> = {
  decomposing: ["awaiting_approval", "failed", "cancelled"],
  awaiting_approval: ["decomposing", "executing", "failed", "cancelled"],
  executing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canPbiTransition(from: PbiStatus, to: PbiStatus): boolean {
  return PBI_TRANSITIONS[from].includes(to);
}

// ---- sub-task 状態機械 --------------------------------------------------

export type SubTaskState =
  | "pending" // 未着手（依存待ちを含む。発射可否はグラフから導出）
  | "running" // Launch Pad ジョブ実行中
  | "in_review" // PR 作成済み・人間のマージ待ち
  | "merged" // PR マージ済み → 完了
  | "done_no_pr" // 差分なしで完了（PR なし）→ 完了扱い
  | "failed" // ジョブ失敗 / PR がマージなしクローズ → エスカレーション
  | "skipped"; // 人間がスキップ指示

const SUBTASK_TRANSITIONS: Record<SubTaskState, readonly SubTaskState[]> = {
  pending: ["running", "skipped", "failed"],
  running: ["in_review", "done_no_pr", "failed", "skipped"],
  in_review: ["merged", "failed", "skipped"],
  failed: ["running", "pending", "skipped"], // 失敗 → リトライ / スキップ
  merged: [],
  done_no_pr: [], // 終端（PR なし完了）
  skipped: [],
};

export function canSubTaskTransition(
  from: SubTaskState,
  to: SubTaskState,
): boolean {
  return SUBTASK_TRANSITIONS[from].includes(to);
}

// ---- 分解結果（エージェントの構造化出力） --------------------------------

export type SubTask = {
  /** 分解時に採番する安定 key（t1, t2, ...）。sub-issue 番号とは別。 */
  key: string;
  title: string;
  goal: string;
  /** この PR で何を作るか。1 PR = 1 revert 単位。 */
  deliverable: string;
  acceptanceCriteria: string[];
  /** 依存する他 SubTask の key の配列。 */
  dependsOn: string[];
};

export function isSubTaskArray(value: unknown): value is SubTask[] {
  if (!Array.isArray(value)) return false;
  return value.every((t) => {
    if (!t || typeof t !== "object") return false;
    const o = t as Record<string, unknown>;
    return (
      typeof o.key === "string" &&
      typeof o.title === "string" &&
      typeof o.goal === "string" &&
      typeof o.deliverable === "string" &&
      Array.isArray(o.acceptanceCriteria) &&
      o.acceptanceCriteria.every((s) => typeof s === "string") &&
      Array.isArray(o.dependsOn) &&
      o.dependsOn.every((s) => typeof s === "string")
    );
  });
}

// ---- PBI レコード -------------------------------------------------------

export type SubTaskRecord = SubTask & {
  state: SubTaskState;
  /** runner が作成した sub-issue 番号。作成前は null。 */
  issueNumber: number | null;
  /** 対応する Launch Pad Job の id。発射前は null。 */
  jobId: string | null;
  branch: string | null;
  prUrl: string | null;
};

export type PbiEscalationKind =
  | "decomposition_approval"
  | "task_failed"
  | "pr_closed_unmerged"
  | "review_comments";

export type PbiEscalation = {
  id: string;
  kind: PbiEscalationKind;
  /** decomposition_approval は null、それ以外は対象 sub-task の key。 */
  subTaskKey: string | null;
  detail: string;
  createdAt: string;
};

export type PbiJob = {
  id: string;
  repo: string; // "yonda/cockpit"
  issueNumber: number; // 親 PBI issue
  title: string;
  status: PbiStatus;
  /** executing 中の一時停止（新規発射だけ止める）。status とは直交。 */
  paused: boolean;
  subTasks: SubTaskRecord[];
  escalations: PbiEscalation[];
  /** 分解のやり直し回数（暴走ガード用）。 */
  decompositionAttempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

// ---- ソケットプロトコル (PBI) ---------------------------------------------

export type PbiRunnerRequest =
  | { id: string; method: "pbi.list"; params: Record<string, never> }
  | {
      id: string;
      method: "pbi.fire";
      params: { repo: string; issueNumber: number; title: string };
    }
  | { id: string; method: "pbi.approve"; params: { pbiId: string } }
  | {
      id: string;
      method: "pbi.revise";
      params: { pbiId: string; feedback: string };
    }
  | { id: string; method: "pbi.reject"; params: { pbiId: string } }
  | { id: string; method: "pbi.pause"; params: { pbiId: string } }
  | { id: string; method: "pbi.resume"; params: { pbiId: string } }
  | {
      id: string;
      method: "pbi.retryTask";
      params: { pbiId: string; key: string };
    }
  | {
      id: string;
      method: "pbi.skipTask";
      params: { pbiId: string; key: string };
    }
  | { id: string; method: "pbi.cancel"; params: { pbiId: string } }
  | {
      id: string;
      method: "pbi.fireReviewReply";
      params: { pbiId: string; key: string };
    };

export type PbiRunnerEvent = { event: "pbi.updated"; data: PbiJob };
