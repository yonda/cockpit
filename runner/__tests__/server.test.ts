import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, RunnerEvent } from "../../lib/jobs/types";
import type { PbiRunnerEvent } from "../../lib/pbi/types";
import { InputBroker } from "../input-broker";
import { PbiStore } from "../pbi-store";
import type { PbiServerDeps } from "../pbi-server";
import { Scheduler } from "../scheduler";
import { startRunnerServer } from "../server";
import { JobStore } from "../store";

let dir: string;
let socketPath: string;
let store: JobStore;
let server: Server;
let scheduler: Scheduler;
let broker: InputBroker;
let pbi: PbiServerDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "srv-"));
  socketPath = join(dir, "runner.sock");
  process.env.RUNNER_SOCKET_PATH = socketPath;
  store = new JobStore(join(dir, "jobs"));
  store.loadAll();
  broker = new InputBroker();
  scheduler = new Scheduler(
    {
      store,
      broker,
      commands: { run: async () => ({ stdout: "", stderr: "" }) },
      executor: { run: async () => ({ ok: true as const }) },
      repoDir: dir,
    },
    { runJob: () => new Promise<void>(() => {}) }, // ジョブは進めない
  );
  const pbiStore = new PbiStore(join(dir, "pbis"));
  pbiStore.loadAll();
  pbi = {
    pbiStore,
    lifecycle: {
      store: pbiStore,
      executor: { run: async () => ({ ok: true as const }) },
      github: {
        fetchIssue: async () => ({ title: "", body: "" }),
        createSubIssue: async () => ({ number: 1, url: "" }),
        updateIssueBody: async () => {},
        closeIssue: async () => {},
        prStateForBranch: async () => ({ kind: "none" as const }),
      },
      prepareCwd: async () => ({ cwd: dir, cleanup: async () => {} }),
    },
    exec: { pbiStore, jobStore: store, scheduler },
  };
  server = startRunnerServer(socketPath, { store, scheduler, broker, pbi });
});

afterEach(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RUNNER_SOCKET_PATH;
  vi.resetModules(); // client が SOCKET_PATH を再評価できるように
});

// lib/runner/client は module 評価時に env を読むため動的 import する
async function client() {
  return await import("../../lib/runner/client");
}

describe("runner socket protocol", () => {
  it("job.fire creates a queued job and job.list returns it", async () => {
    const { callRunner } = await client();
    const fired = await callRunner<{ job: Job }>("job.fire", {
      repo: "yonda/cockpit",
      issueNumber: 5,
      issueTitle: "Add launch pad",
    });
    expect(fired.job.branch).toBe("feature/5-add-launch-pad");

    const { jobs } = await callRunner<{ jobs: Job[] }>("job.list", {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(fired.job.id);
  });

  it("rejects a duplicate fire for the same issue", async () => {
    const { callRunner } = await client();
    await callRunner("job.fire", {
      repo: "yonda/cockpit",
      issueNumber: 5,
      issueTitle: "Add launch pad",
    });
    await expect(
      callRunner("job.fire", {
        repo: "yonda/cockpit",
        issueNumber: 5,
        issueTitle: "Add launch pad",
      }),
    ).rejects.toThrow(/already active/);
  });

  it("streams job.updated events to subscribers", async () => {
    const { callRunner, openRunnerEventStream } = await client();
    const events: (RunnerEvent | PbiRunnerEvent)[] = [];
    const ac = new AbortController();
    openRunnerEventStream({
      signal: ac.signal,
      onEvent: (e) => events.push(e),
      onError: () => {},
    });
    await new Promise((r) => setTimeout(r, 50)); // subscribe 完了待ち

    await callRunner("job.fire", {
      repo: "yonda/cockpit",
      issueNumber: 7,
      issueTitle: "stream test",
    });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    expect(events.some((e) => e.event === "job.updated")).toBe(true);
  });

  it("job.respond resolves the broker", async () => {
    const { callRunner } = await client();
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 9,
      issueTitle: "respond test",
      branch: "feature/9-respond-test",
    });
    store.transition(job.id, "running");
    const input = {
      id: "in-1",
      kind: "permission" as const,
      toolName: "Bash",
      input: { command: "true" },
      createdAt: new Date().toISOString(),
    };
    store.transition(job.id, "waiting_input", { pendingInput: input });
    const pending = broker.request(job.id, input);

    await callRunner("job.respond", {
      jobId: job.id,
      inputId: "in-1",
      response: { kind: "allow" },
    });
    await expect(pending).resolves.toEqual({ kind: "allow" });
  });

  it("responds with an error (not a hang/crash) when a pbi.* method rejects at the handlePbiRequest layer", async () => {
    // pbi.pause on 未知の pbiId は PbiStore.mustGet の同期 throw により
    // handlePbiRequest の Promise を reject させる。Fix 2 前は handleLine の
    // `void handlePbiRequest(...).then((r) => respond(...))` に onRejected が
    // 無く、unhandledRejection でデーモンごと落ちた上、クライアントは
    // 5s タイムアウトまで応答を待たされていた。
    const { callRunner } = await client();
    let unhandled: unknown;
    const onUnhandledRejection = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      await expect(
        callRunner("pbi.pause", { pbiId: "pbi-does-not-exist" }),
      ).rejects.toThrow(/unknown pbi/);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    expect(unhandled).toBeUndefined();
  });

  it("rejects job.respond with an invalid response shape", async () => {
    const { callRunner } = await client();
    const job = store.create({
      repo: "yonda/cockpit",
      issueNumber: 10,
      issueTitle: "invalid respond test",
      branch: "feature/10-invalid-respond-test",
    });

    await expect(
      callRunner("job.respond", {
        jobId: job.id,
        inputId: "in-1",
        response: {},
      }),
    ).rejects.toThrow(/invalid response shape/);
  });
});
