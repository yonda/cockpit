import { describe, expect, it } from "vitest";
import type { SubTaskRecord, SubTaskState } from "../../lib/pbi/types";
import {
  hasBlockedProgress,
  isPbiComplete,
  readySubTasks,
  validateDependencies,
} from "../pbi-graph";

const t = (
  key: string,
  state: SubTaskState,
  dependsOn: string[] = [],
): SubTaskRecord => ({
  key,
  title: key,
  goal: "",
  deliverable: "",
  acceptanceCriteria: [],
  dependsOn,
  state,
  issueNumber: null,
  jobId: null,
  branch: null,
  prUrl: null,
});

describe("readySubTasks", () => {
  it("returns pending tasks whose dependencies are all merged", () => {
    const tasks = [
      t("t1", "merged"),
      t("t2", "pending", ["t1"]),
      t("t3", "pending", ["t2"]),
    ];
    expect(readySubTasks(tasks).map((x) => x.key)).toEqual(["t2"]);
  });
  it("treats skipped dependencies as satisfied", () => {
    const tasks = [t("t1", "skipped"), t("t2", "pending", ["t1"])];
    expect(readySubTasks(tasks).map((x) => x.key)).toEqual(["t2"]);
  });
  it("treats done_no_pr dependencies as satisfied (差分なし完了でブロック解除)", () => {
    const tasks = [t("t1", "done_no_pr"), t("t2", "pending", ["t1"])];
    expect(readySubTasks(tasks).map((x) => x.key)).toEqual(["t2"]);
  });
  it("excludes tasks with an unmet dependency", () => {
    const tasks = [t("t1", "running"), t("t2", "pending", ["t1"])];
    expect(readySubTasks(tasks)).toEqual([]);
  });
});

describe("isPbiComplete", () => {
  it("is true only when every task is merged or skipped", () => {
    expect(isPbiComplete([t("t1", "merged"), t("t2", "skipped")])).toBe(true);
    expect(isPbiComplete([t("t1", "merged"), t("t2", "in_review")])).toBe(false);
    expect(isPbiComplete([])).toBe(false);
  });
  it("counts done_no_pr as completed", () => {
    expect(isPbiComplete([t("t1", "done_no_pr"), t("t2", "merged")])).toBe(true);
    expect(isPbiComplete([t("t1", "done_no_pr"), t("t2", "pending")])).toBe(
      false,
    );
  });
});

describe("hasBlockedProgress", () => {
  it("detects a deadlock: nothing ready, nothing running, not complete", () => {
    // t2 は t1 に依存するが t1 が failed のまま → 前進不能
    const tasks = [t("t1", "failed"), t("t2", "pending", ["t1"])];
    expect(hasBlockedProgress(tasks)).toBe(true);
  });
  it("is false while a task is still running", () => {
    const tasks = [t("t1", "running"), t("t2", "pending", ["t1"])];
    expect(hasBlockedProgress(tasks)).toBe(false);
  });
});

describe("validateDependencies", () => {
  it("passes a clean DAG", () => {
    expect(
      validateDependencies([t("t1", "pending"), t("t2", "pending", ["t1"])]),
    ).toBeNull();
  });
  it("flags an unknown dependency key", () => {
    expect(validateDependencies([t("t2", "pending", ["t1"])])).toMatch(/t1/);
  });
  it("flags a cycle", () => {
    const tasks = [
      t("t1", "pending", ["t2"]),
      t("t2", "pending", ["t1"]),
    ];
    expect(validateDependencies(tasks)).toMatch(/循環|cycle/);
  });
});
