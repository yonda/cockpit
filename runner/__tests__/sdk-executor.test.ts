import { describe, expect, it, vi } from "vitest";
import type { PendingInput, PendingInputResponse } from "../../lib/jobs/types";
import type { ExecutorHooks } from "../executor";
import { buildCanUseTool, toPermissionResult } from "../sdk-executor";

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
