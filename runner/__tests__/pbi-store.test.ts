import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubTaskRecord } from "../../lib/pbi/types";
import { PbiStore } from "../pbi-store";

let dir: string;
let store: PbiStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pbi-"));
  store = new PbiStore(dir);
  store.loadAll();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (over: Partial<SubTaskRecord>): SubTaskRecord => ({
  key: "t1",
  title: "t",
  goal: "g",
  deliverable: "d",
  acceptanceCriteria: [],
  dependsOn: [],
  state: "pending",
  issueNumber: null,
  jobId: null,
  branch: null,
  prUrl: null,
  ...over,
});

describe("PbiStore", () => {
  it("creates a PBI in decomposing and persists it across reloads", () => {
    const pbi = store.create({
      repo: "yonda/cockpit",
      issueNumber: 42,
      title: "Launch Pad",
    });
    expect(pbi.status).toBe("decomposing");
    expect(pbi.decompositionAttempts).toBe(0);

    const reloaded = new PbiStore(dir);
    reloaded.loadAll();
    expect(reloaded.get(pbi.id)?.issueNumber).toBe(42);
  });

  it("enforces the state machine on transition", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    expect(() => store.transition(pbi.id, "completed")).toThrow(
      /invalid transition/,
    );
    store.transition(pbi.id, "awaiting_approval");
    expect(store.get(pbi.id)?.status).toBe("awaiting_approval");
  });

  it("rejects status changes through update()", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    expect(() =>
      store.update(pbi.id, { status: "executing" }),
    ).toThrow(/use transition/);
  });

  it("sets sub-tasks and transitions one with a patch", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    store.setSubTasks(pbi.id, [rec({ key: "t1" }), rec({ key: "t2" })]);
    store.transitionSubTask(pbi.id, "t1", "running", { jobId: "job-9" });
    const t1 = store.get(pbi.id)!.subTasks.find((t) => t.key === "t1")!;
    expect(t1.state).toBe("running");
    expect(t1.jobId).toBe("job-9");
  });

  it("adds and clears escalations", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    const withEsc = store.addEscalation(pbi.id, {
      kind: "task_failed",
      subTaskKey: "t1",
      detail: "boom",
    });
    const escId = withEsc.escalations[0].id;
    expect(withEsc.escalations).toHaveLength(1);
    const cleared = store.clearEscalation(pbi.id, escId);
    expect(cleared.escalations).toHaveLength(0);
  });

  it("emits a pbi event on every mutation", () => {
    const pbi = store.create({ repo: "r", issueNumber: 1, title: "t" });
    const seen: string[] = [];
    store.on("pbi", (p) => seen.push(p.status));
    store.transition(pbi.id, "awaiting_approval");
    expect(seen).toContain("awaiting_approval");
  });
});
