import { describe, expect, it } from "vitest";
import {
  canPbiTransition,
  canSubTaskTransition,
  isSubTaskArray,
  NO_CHANGES_MARKER,
  SUBTASK_MARKER,
} from "../../lib/pbi/types";

describe("markers", () => {
  it("exports distinct html-comment markers", () => {
    expect(NO_CHANGES_MARKER).toBe("<!-- cockpit:no-changes -->");
    expect(NO_CHANGES_MARKER).not.toBe(SUBTASK_MARKER);
  });
});

describe("canPbiTransition", () => {
  it("allows decomposing -> awaiting_approval and the revise loop", () => {
    expect(canPbiTransition("decomposing", "awaiting_approval")).toBe(true);
    expect(canPbiTransition("awaiting_approval", "decomposing")).toBe(true);
    expect(canPbiTransition("awaiting_approval", "executing")).toBe(true);
    expect(canPbiTransition("executing", "completed")).toBe(true);
  });
  it("rejects terminal and skipping transitions", () => {
    expect(canPbiTransition("completed", "executing")).toBe(false);
    expect(canPbiTransition("decomposing", "executing")).toBe(false);
    expect(canPbiTransition("decomposing", "completed")).toBe(false);
  });
  it("allows cancel/fail from any non-terminal state", () => {
    expect(canPbiTransition("decomposing", "cancelled")).toBe(true);
    expect(canPbiTransition("executing", "failed")).toBe(true);
  });
});

describe("canSubTaskTransition", () => {
  it("allows the happy path pending -> running -> in_review -> merged", () => {
    expect(canSubTaskTransition("pending", "running")).toBe(true);
    expect(canSubTaskTransition("running", "in_review")).toBe(true);
    expect(canSubTaskTransition("in_review", "merged")).toBe(true);
  });
  it("allows recovery: failed -> running (retry) and any -> skipped", () => {
    expect(canSubTaskTransition("failed", "running")).toBe(true);
    expect(canSubTaskTransition("pending", "skipped")).toBe(true);
    expect(canSubTaskTransition("in_review", "failed")).toBe(true);
  });
  it("allows failed -> pending for retry / boot reconciliation", () => {
    expect(canSubTaskTransition("failed", "pending")).toBe(true);
  });
  it("allows failed -> in_review / merged for PR fallback recovery", () => {
    expect(canSubTaskTransition("failed", "in_review")).toBe(true);
    expect(canSubTaskTransition("failed", "merged")).toBe(true);
  });
  it("allows failed -> done_no_pr for human markTaskDone recovery", () => {
    expect(canSubTaskTransition("failed", "done_no_pr")).toBe(true);
  });
  it("allows pending -> in_review / merged (発射前ガードの PR 実態への整合)", () => {
    expect(canSubTaskTransition("pending", "in_review")).toBe(true);
    expect(canSubTaskTransition("pending", "merged")).toBe(true);
  });
  it("allows running -> done_no_pr (差分なし完了) but not from other states", () => {
    expect(canSubTaskTransition("running", "done_no_pr")).toBe(true);
    expect(canSubTaskTransition("pending", "done_no_pr")).toBe(false);
    expect(canSubTaskTransition("in_review", "done_no_pr")).toBe(false);
  });
  it("treats done_no_pr as a terminal state", () => {
    expect(canSubTaskTransition("done_no_pr", "running")).toBe(false);
    expect(canSubTaskTransition("done_no_pr", "merged")).toBe(false);
    expect(canSubTaskTransition("done_no_pr", "failed")).toBe(false);
  });
  it("rejects transitions out of terminal states", () => {
    expect(canSubTaskTransition("merged", "running")).toBe(false);
    expect(canSubTaskTransition("skipped", "running")).toBe(false);
  });
});

describe("isSubTaskArray", () => {
  const valid = [
    {
      key: "t1",
      title: "型を作る",
      goal: "土台",
      deliverable: "types.ts",
      acceptanceCriteria: ["テストが通る"],
      dependsOn: [],
    },
    {
      key: "t2",
      title: "store を作る",
      goal: "永続化",
      deliverable: "store.ts",
      acceptanceCriteria: ["保存できる"],
      dependsOn: ["t1"],
    },
  ];
  it("accepts a well-formed array", () => {
    expect(isSubTaskArray(valid)).toBe(true);
  });
  it("rejects missing fields and wrong types", () => {
    expect(isSubTaskArray([{ key: "t1" }])).toBe(false);
    expect(isSubTaskArray("nope")).toBe(false);
    expect(isSubTaskArray([{ ...valid[0], dependsOn: "t1" }])).toBe(false);
  });
});
