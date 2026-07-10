import { describe, expect, it } from "vitest";
import { toPermissionResult } from "../sdk-executor";

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
});
