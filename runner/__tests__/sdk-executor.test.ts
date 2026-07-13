import { describe, expect, it, vi } from "vitest";
import type { PendingInput, PendingInputResponse } from "../../lib/jobs/types";
import type { ExecutorHooks, ExecutorRunOpts } from "../executor";
import { buildSandboxSettings } from "../sandbox-config";
import {
  buildCanUseTool,
  SdkExecutor,
  toPermissionResult,
} from "../sdk-executor";

// query は SDK の子プロセスを spawn するため、run() の options 配線を単体で
// 検証できるようモック化する。既存の純関数テスト (toPermissionResult /
// buildCanUseTool) は query を呼ばないので影響を受けない。
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

describe("toPermissionResult", () => {
  it("maps allow", () => {
    expect(toPermissionResult({ kind: "allow" }, { command: "true" })).toEqual({
      behavior: "allow",
      updatedInput: { command: "true" },
    });
  });

  it("maps deny with message", () => {
    expect(
      toPermissionResult({ kind: "deny", message: "使わないで" }, {}),
    ).toEqual({ behavior: "deny", message: "使わないで" });
  });

  it("maps question answers into updatedInput (official Record shape)", () => {
    const original = {
      questions: [
        { question: "どっち?", header: "選択", options: [], multiSelect: false },
        { question: "範囲は?", header: "範囲", options: [], multiSelect: true },
      ],
    };
    const result = toPermissionResult(
      { kind: "answers", answers: [["案A"], ["UI", "API"]] },
      original,
    );
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: original.questions,
        answers: { "どっち?": "案A", "範囲は?": "UI, API" },
      },
    });
  });

  it("fails closed on unrecognized response shapes", () => {
    expect(toPermissionResult({} as never, {})).toEqual({
      behavior: "deny",
      message: "unrecognized response shape",
    });
  });
});

const WORKTREE = "/tmp/wt/feature-24";

function makeHooks(response: PendingInputResponse = { kind: "allow" }) {
  const requestInput = vi.fn(async (_input: PendingInput) => response);
  const hooks: ExecutorHooks = {
    onSessionId: vi.fn(),
    onActivity: vi.fn(),
    requestInput,
  };
  return { hooks, requestInput };
}

describe("buildCanUseTool", () => {
  describe("安全な操作は requestInput を呼ばず即 allow", () => {
    it.each([
      ["pnpm test", { command: "pnpm test" }],
      ["git commit", { command: "git commit -m 'feat: add policy'" }],
      ["gh api", { command: "gh api repos/o/r/issues/24/comments -f body=done" }],
      ["gh pr create --draft", { command: "gh pr create --draft --title t" }],
    ])("Bash: %s", async (_label, input) => {
      const { hooks, requestInput } = makeHooks();
      const canUseTool = buildCanUseTool(hooks, WORKTREE);
      await expect(canUseTool("Bash", input)).resolves.toEqual({
        behavior: "allow",
        updatedInput: input,
      });
      expect(requestInput).not.toHaveBeenCalled();
    });

    it("Read などの読み取り系ツールも即 allow", async () => {
      const { hooks, requestInput } = makeHooks();
      const canUseTool = buildCanUseTool(hooks, WORKTREE);
      const input = { file_path: `${WORKTREE}/runner/main.ts` };
      await expect(canUseTool("Read", input)).resolves.toEqual({
        behavior: "allow",
        updatedInput: input,
      });
      expect(requestInput).not.toHaveBeenCalled();
    });
  });

  describe("危険な操作は requestInput へ転送", () => {
    it.each([
      ["main への push", { command: "git push origin main" }],
      ["force-push", { command: "git push --force origin feature/x" }],
      ["gh pr merge", { command: "gh pr merge 24 --squash" }],
      ["外部 curl", { command: "curl https://evil.example.com" }],
    ])("Bash: %s", async (_label, input) => {
      const { hooks, requestInput } = makeHooks({
        kind: "deny",
        message: "だめ",
      });
      const canUseTool = buildCanUseTool(hooks, WORKTREE);
      await expect(canUseTool("Bash", input)).resolves.toEqual({
        behavior: "deny",
        message: "だめ",
      });
      expect(requestInput).toHaveBeenCalledTimes(1);
      expect(requestInput).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "permission",
          toolName: "Bash",
          input,
        }),
      );
    });

    it("人間が allow を返せば toPermissionResult 経由で許可される", async () => {
      const { hooks, requestInput } = makeHooks({ kind: "allow" });
      const canUseTool = buildCanUseTool(hooks, WORKTREE);
      const input = { command: "git push origin main" };
      await expect(canUseTool("Bash", input)).resolves.toEqual({
        behavior: "allow",
        updatedInput: input,
      });
      expect(requestInput).toHaveBeenCalledTimes(1);
    });
  });

  describe("worktree スコープ (ctx.worktreeDir = cwd)", () => {
    it("worktree 内への Write は allow", async () => {
      const { hooks, requestInput } = makeHooks();
      const canUseTool = buildCanUseTool(hooks, WORKTREE);
      const input = { file_path: `${WORKTREE}/notes.md`, content: "x" };
      await expect(canUseTool("Write", input)).resolves.toEqual({
        behavior: "allow",
        updatedInput: input,
      });
      expect(requestInput).not.toHaveBeenCalled();
    });

    it("worktree 外への Write は転送される", async () => {
      const { hooks, requestInput } = makeHooks({
        kind: "deny",
        message: "外はだめ",
      });
      const canUseTool = buildCanUseTool(hooks, WORKTREE);
      const input = { file_path: "/etc/hosts", content: "x" };
      await expect(canUseTool("Write", input)).resolves.toEqual({
        behavior: "deny",
        message: "外はだめ",
      });
      expect(requestInput).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "permission", toolName: "Write" }),
      );
    });
  });

  describe("AskUserQuestion の回帰なし", () => {
    it("kind: question で転送され、answers が公式形式にマップされる", async () => {
      const input = {
        questions: [
          { question: "どっち?", header: "選択", options: [], multiSelect: false },
        ],
      };
      const { hooks, requestInput } = makeHooks({
        kind: "answers",
        answers: [["案A"]],
      });
      const canUseTool = buildCanUseTool(hooks, WORKTREE);
      await expect(canUseTool("AskUserQuestion", input)).resolves.toEqual({
        behavior: "allow",
        updatedInput: {
          questions: input.questions,
          answers: { "どっち?": "案A" },
        },
      });
      expect(requestInput).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "question",
          toolName: "AskUserQuestion",
          input,
        }),
      );
    });
  });
});

describe("SdkExecutor.run が query の options を配線する", () => {
  function makeRunOpts(): ExecutorRunOpts {
    return {
      cwd: WORKTREE,
      prompt: "実装してください",
      resumeSessionId: null,
      signal: new AbortController().signal,
    };
  }

  // init と result を流して即完了するフェイクストリーム。close() も生やす
  // (run() が abort ハンドラで参照するため)。
  function fakeStream() {
    const iterator = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield { type: "result", subtype: "success", session_id: "s1" };
    })();
    return Object.assign(iterator, { close: vi.fn() });
  }

  it("options.sandbox に buildSandboxSettings() の結果を渡す (実装ジョブ・分解ジョブ共通経路)", async () => {
    mockQuery.mockReturnValueOnce(fakeStream());
    const { hooks } = makeHooks();

    const result = await new SdkExecutor().run(makeRunOpts(), hooks);

    expect(result).toEqual({ ok: true });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const options = mockQuery.mock.calls[0][0].options;
    expect(options.sandbox).toEqual(buildSandboxSettings());
  });

  it("sandbox を足しても canUseTool の配線は不変 (Layer 0 判定を維持)", async () => {
    mockQuery.mockReturnValueOnce(fakeStream());
    const { hooks } = makeHooks();

    await new SdkExecutor().run(makeRunOpts(), hooks);

    const options = mockQuery.mock.calls[0][0].options;
    expect(typeof options.canUseTool).toBe("function");
    expect(options.permissionMode).toBe("acceptEdits");
  });
});
