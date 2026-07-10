import {
  query,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PendingInputResponse } from "../lib/jobs/types";
import type {
  AgentExecutor,
  ExecutorHooks,
  ExecutorResult,
  ExecutorRunOpts,
} from "./executor";

// 定型ワークフローに必要なツールは事前許可。ここに無い Bash・外部送信系と
// AskUserQuestion が canUseTool に落ちて cockpit へ転送される。
const ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "TodoWrite",
  "Task",
  "Bash(git:*)",
  "Bash(gh issue view:*)",
  "Bash(gh pr create --draft:*)",
  "Bash(gh pr list:*)",
  "Bash(pnpm install:*)",
  "Bash(pnpm test:*)",
  "Bash(pnpm lint:*)",
  "Bash(pnpm build:*)",
  "Bash(pnpm vitest:*)",
];

export function toPermissionResult(
  response: PendingInputResponse,
  originalInput: Record<string, unknown>,
): PermissionResult {
  if (response.kind === "deny") {
    return { behavior: "deny", message: response.message };
  }
  if (response.kind === "answers") {
    // AskUserQuestion の公式応答形式 (user-input docs "Handle clarifying questions"):
    //   { questions: <原文そのまま>, answers: { "<質問文>": "<選択ラベル>" } }
    // multiSelect は ", " 区切りの文字列にする
    const questions = (originalInput.questions ?? []) as Array<{
      question: string;
    }>;
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.question] = (response.answers[i] ?? []).join(", ");
    });
    return {
      behavior: "allow",
      updatedInput: { questions: originalInput.questions, answers },
    };
  }
  if (response.kind === "allow") {
    return { behavior: "allow", updatedInput: originalInput };
  }
  // 未知の形は fail-closed: 誤って許可に倒さない
  return { behavior: "deny", message: "unrecognized response shape" };
}

function extractAssistantText(message: SDKMessage): string | null {
  if (message.type !== "assistant") return null;
  const content = message.message.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text.slice(0, 200);
    }
    if (block.type === "tool_use") {
      return `tool: ${block.name}`;
    }
  }
  return null;
}

export class SdkExecutor implements AgentExecutor {
  async run(
    opts: ExecutorRunOpts,
    hooks: ExecutorHooks,
  ): Promise<ExecutorResult> {
    try {
      const stream = query({
        prompt: opts.prompt,
        options: {
          cwd: opts.cwd,
          permissionMode: "acceptEdits",
          allowedTools: ALLOWED_TOOLS,
          resume: opts.resumeSessionId ?? undefined,
          // 実際の CanUseTool は (toolName, input, { signal, toolUseID, ... })
          // の3引数。3番目の control メタデータはここでは使わない。
          canUseTool: async (toolName, input) => {
            const response = await hooks.requestInput({
              id: "", // workflow 側で採番される
              kind: toolName === "AskUserQuestion" ? "question" : "permission",
              toolName,
              input,
              createdAt: "",
            });
            return toPermissionResult(response, input);
          },
        },
      });

      // ジョブキャンセル: 子プロセスを強制終了する。
      // (interrupt() は streaming input モード限定のため string prompt では使えない。
      //  close() は SDK が spawn した CLI プロセスを終了させる)
      const onAbort = () => {
        stream.close();
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });

      try {
        for await (const message of stream) {
          if (message.type === "system" && message.subtype === "init") {
            hooks.onSessionId(message.session_id);
          }
          const activity = extractAssistantText(message);
          if (activity) hooks.onActivity(activity);
          if (message.type === "result") {
            // result には session_id が必ず入る (init を取り逃しても確実に保存)
            hooks.onSessionId(message.session_id);
            return message.subtype === "success"
              ? { ok: true }
              : { ok: false, error: `agent finished with ${message.subtype}` };
          }
        }
        return { ok: false, error: "stream ended without result message" };
      } finally {
        opts.signal.removeEventListener("abort", onAbort);
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
