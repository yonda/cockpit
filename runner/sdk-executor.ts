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
import { evaluateToolUse } from "./permission-policy";
import { buildSandboxSettings } from "./sandbox-config";

// 許可判定は permission-policy (evaluateToolUse) に集約した。canUseTool が
// default-allow で判定し、危険な操作 (保護ブランチへの push・force-push・
// gh pr merge・外部送信等) のみ cockpit へ転送する。かつて存在した
// allowedTools の事前許可リストは、policy と二重管理になるため撤廃した。
//
// Edit/Write を allowedTools で事前許可してはならない (今後も追加禁止):
// allowedTools の許可はパス無制限で、permissionMode: "acceptEdits" が持つ
// cwd (worktree) スコープを上書きしてしまい、worktree 外への書き込みが
// 無警告で行えるようになる。現在の構成では worktree 内の編集は acceptEdits が
// 自動承認し、worktree 外への書き込みは canUseTool に落ちて permission-policy が
// パス判定のうえ escalate (cockpit へ転送) する。

// headless 実装ジョブでは使わせないツール。deny rules は canUseTool より前に評価される
// ため、プロンプトを出さずに拒否される。Skill: グローバル CLAUDE.md の PR ワークフローを
// 継承して /code-review 等を呼ぼうとするのを止める（セルフレビューは runner の DoD ゲート側の
// 責務で、実装エージェント自身にはさせない）。
const DISALLOWED_TOOLS = ["Skill"];

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

// canUseTool の実体。テスト可能なようにファクトリとして切り出している。
// permission-policy で判定し、allow なら requestInput を経由せず即許可、
// escalate なら従来どおり cockpit (hooks.requestInput) へ転送する。
// AskUserQuestion は policy 側で必ず escalate になり、kind: "question" で転送される。
export function buildCanUseTool(
  hooks: ExecutorHooks,
  cwd: string,
): (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<PermissionResult> {
  return async (toolName, input) => {
    const decision = evaluateToolUse(toolName, input, { worktreeDir: cwd });
    if (decision.decision === "allow") {
      return { behavior: "allow", updatedInput: input };
    }
    const response = await hooks.requestInput({
      id: "", // workflow 側で採番される
      kind: toolName === "AskUserQuestion" ? "question" : "permission",
      toolName,
      input,
      createdAt: "",
    });
    return toPermissionResult(response, input);
  };
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
          disallowedTools: DISALLOWED_TOOLS,
          resume: opts.resumeSessionId ?? undefined,
          // Seatbelt (sandbox) を全実行に適用する。SdkExecutor は scheduler の
          // 実装ジョブと pbi-lifecycle の分解ジョブ (detached worktree での読み取り
          // 解析 + decomposition.json 書き出し) の両方で共有される (runner/main.ts で
          // それぞれに new SdkExecutor() を渡している) ため、ここに sandbox を配線すると
          // 両経路のエージェント実行がまとめて sandbox 化される。
          // buildSandboxSettings() は failIfUnavailable: true の fail-closed 構成で、
          // かつ autoAllowBashIfSandboxed: false のため下の canUseTool が全 Bash に
          // 効き続ける (Layer 0 判定は不変)。詳細は runner/sandbox-config.ts を参照。
          sandbox: buildSandboxSettings(),
          // 実際の CanUseTool は (toolName, input, { signal, toolUseID, ... })
          // の3引数。3番目の control メタデータはここでは使わない。
          canUseTool: buildCanUseTool(hooks, opts.cwd),
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
