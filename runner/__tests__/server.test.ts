import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, RunnerEvent } from "../../lib/jobs/types";
import { InputBroker } from "../input-broker";
import { Scheduler } from "../scheduler";
import { startRunnerServer } from "../server";
import { JobStore } from "../store";

let dir: string;
let socketPath: string;
let store: JobStore;
let server: Server;
let scheduler: Scheduler;
let broker: InputBroker;

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
  server = startRunnerServer(socketPath, { store, scheduler, broker });
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
    const events: RunnerEvent[] = [];
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
});
