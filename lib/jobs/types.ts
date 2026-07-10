import { homedir } from "node:os";
import { join } from "node:path";

// ---- 定数 -------------------------------------------------------------

export const LAUNCH_REPO = process.env.LAUNCH_REPO ?? "yonda/cockpit";
export const RUNNER_SOCKET_PATH =
  process.env.RUNNER_SOCKET_PATH ?? join(homedir(), ".cache", "cockpit", "runner.sock");
export const JOBS_DIR =
  process.env.RUNNER_JOBS_DIR ?? join(homedir(), ".cache", "cockpit", "jobs");

// ---- ジョブ状態機械 ------------------------------------------------------

export type JobStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "done"
  | "failed"
  | "cancelled";

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting_input", "done", "failed", "cancelled"],
  waiting_input: ["running", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// ---- 許可・質問の転送 ----------------------------------------------------

export type PendingInputKind = "permission" | "question";

export type PendingInput = {
  id: string;
  kind: PendingInputKind;
  toolName: string;
  /** canUseTool に渡ってきた input そのまま (UI が要約表示する) */
  input: unknown;
  createdAt: string;
};

export type PendingInputResponse =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  /** AskUserQuestion への回答。質問ごとに選択肢ラベルの配列 */
  | { kind: "answers"; answers: string[][] };

export function isPendingInputResponse(
  value: unknown,
): value is PendingInputResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as { kind?: unknown; message?: unknown; answers?: unknown };
  if (v.kind === "allow") return true;
  if (v.kind === "deny") return typeof v.message === "string";
  if (v.kind === "answers") {
    return (
      Array.isArray(v.answers) &&
      v.answers.every(
        (a) => Array.isArray(a) && a.every((s) => typeof s === "string"),
      )
    );
  }
  return false;
}

// ---- ジョブ --------------------------------------------------------------

export type Job = {
  id: string;
  repo: string; // "yonda/cockpit"
  issueNumber: number;
  issueTitle: string;
  branch: string; // feature/<n>-<slug>
  worktreePath: string | null;
  status: JobStatus;
  sessionId: string | null;
  pendingInput: PendingInput | null;
  prUrl: string | null;
  error: string | null;
  /** 直近のツール実行など、UI に出す 1 行アクティビティ */
  lastActivity: string | null;
  createdAt: string;
  updatedAt: string;
};

// ---- ソケットプロトコル (JSON lines) ---------------------------------------

export type RunnerRequest =
  | { id: string; method: "job.list"; params: Record<string, never> }
  | {
      id: string;
      method: "job.fire";
      params: { repo: string; issueNumber: number; issueTitle: string };
    }
  | { id: string; method: "job.cancel"; params: { jobId: string } }
  | {
      id: string;
      method: "job.respond";
      params: { jobId: string; inputId: string; response: PendingInputResponse };
    }
  | { id: string; method: "events.subscribe"; params: Record<string, never> };

export type RunnerResponse = {
  id: string;
  result?: unknown;
  error?: { message: string };
};

export type RunnerEvent = { event: "job.updated"; data: Job };
