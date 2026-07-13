import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputBroker } from "../input-broker";
import { RepoRegistry } from "../repo-registry";
import { Scheduler } from "../scheduler";
import { JobStore } from "../store";
import type { WorkflowDeps } from "../workflow";

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-"));
  store = new JobStore(dir);
  store.loadAll();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fields = (n: number) => ({
  repo: "yonda/cockpit",
  issueNumber: n,
  issueTitle: `issue ${n}`,
  branch: `feature/${n}-issue-${n}`,
});

function makeDeps(): WorkflowDeps {
  return {
    store,
    broker: new InputBroker(),
    commands: { run: async () => ({ stdout: "", stderr: "" }) },
    executor: { run: async () => ({ ok: true as const }) },
    registry: new RepoRegistry([]),
    resolveToken: () => "test-token",
  };
}

describe("Scheduler", () => {
  it("runs at most maxConcurrent jobs at once", async () => {
    const resolvers: Array<() => void> = [];
    // runJob を差し替えて完了タイミングを制御する
    const runJob = vi.fn(
      (_deps: WorkflowDeps, _jobId: string, _signal: AbortSignal) =>
        new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    const scheduler = new Scheduler(makeDeps(), {
      maxConcurrent: 2,
      runJob,
    });

    store.create(fields(1));
    store.create(fields(2));
    store.create(fields(3));
    scheduler.poke();

    expect(runJob).toHaveBeenCalledTimes(2);

    resolvers[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(runJob).toHaveBeenCalledTimes(3);
  });

  it("cancel aborts the signal and marks the job cancelled", async () => {
    let captured: AbortSignal | null = null;
    const runJob = vi.fn(
      (_deps: WorkflowDeps, _jobId: string, signal: AbortSignal) => {
        captured = signal;
        return new Promise<void>(() => {}); // 完了しない
      },
    );
    const scheduler = new Scheduler(makeDeps(), { maxConcurrent: 2, runJob });
    const job = store.create(fields(1));
    scheduler.poke();

    scheduler.cancel(job.id);
    expect(captured!.aborted).toBe(true);
    expect(store.get(job.id)!.status).toBe("cancelled");
  });

  it("resumeOnBoot requeues interrupted jobs with a session and fails those without", () => {
    const j1 = store.create(fields(1));
    store.transition(j1.id, "running", {
      sessionId: "sess-1",
      worktreePath: "/tmp/cockpit-wt/feature/1-issue-1",
    });
    const j2 = store.create(fields(2));
    store.transition(j2.id, "running"); // sessionId なし

    // 再起動をシミュレート
    const reloaded = new JobStore(dir);
    reloaded.loadAll();
    const runJob = vi.fn(() => new Promise<void>(() => {}));
    const scheduler = new Scheduler(
      { ...makeDeps(), store: reloaded },
      { maxConcurrent: 2, runJob },
    );
    scheduler.resumeOnBoot();

    expect(reloaded.get(j1.id)!.status).toBe("running");
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(reloaded.get(j2.id)!.status).toBe("failed");
  });

  it("resumeOnBoot respects maxConcurrent and drains the rest as slots free", async () => {
    const resolvers: Array<() => void> = [];
    const runJob = vi.fn(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    for (const n of [1, 2, 3]) {
      const j = store.create(fields(n));
      store.transition(j.id, "running", {
        sessionId: `sess-${n}`,
        worktreePath: `/tmp/wt-${n}`,
      });
    }
    const reloaded = new JobStore(dir);
    reloaded.loadAll();
    const scheduler = new Scheduler(
      { ...makeDeps(), store: reloaded },
      { maxConcurrent: 2, runJob },
    );
    scheduler.resumeOnBoot();
    expect(runJob).toHaveBeenCalledTimes(2);
    resolvers[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(runJob).toHaveBeenCalledTimes(3);
  });

  it("resumeOnBoot clears pendingInput before re-running a waiting_input job", () => {
    const j = store.create(fields(1));
    store.transition(j.id, "running", { sessionId: "s", worktreePath: "/tmp/wt" });
    store.transition(j.id, "waiting_input", {
      pendingInput: {
        id: "in-1",
        kind: "permission",
        toolName: "Bash",
        input: {},
        createdAt: new Date().toISOString(),
      },
    });
    const reloaded = new JobStore(dir);
    reloaded.loadAll();
    const runJob = vi.fn(() => new Promise<void>(() => {}));
    const scheduler = new Scheduler(
      { ...makeDeps(), store: reloaded },
      { runJob },
    );
    scheduler.resumeOnBoot();
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(reloaded.get(j.id)!.pendingInput).toBeNull();
  });

  it("cancel marks a queued job cancelled before it starts", () => {
    const scheduler = new Scheduler(makeDeps(), { runJob: vi.fn() });
    const job = store.create(fields(1));
    scheduler.cancel(job.id);
    expect(store.get(job.id)!.status).toBe("cancelled");
  });
});
