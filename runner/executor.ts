import type { PendingInput, PendingInputResponse } from "../lib/jobs/types";

export type { CommandRunner } from "./exec";

export type ExecutorRunOpts = {
  cwd: string;
  prompt: string;
  resumeSessionId: string | null;
  signal: AbortSignal;
};

export type ExecutorHooks = {
  onSessionId(sessionId: string): void;
  onActivity(text: string): void;
  requestInput(input: PendingInput): Promise<PendingInputResponse>;
};

export type ExecutorResult = { ok: true } | { ok: false; error: string };

/** Agent SDK を差し替え可能にする境界。テストはフェイク、実運用は SdkExecutor */
export interface AgentExecutor {
  run(opts: ExecutorRunOpts, hooks: ExecutorHooks): Promise<ExecutorResult>;
}
