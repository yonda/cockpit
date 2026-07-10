import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../store";

let dir: string;
let store: JobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobs-"));
  store = new JobStore(dir);
  store.loadAll();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fields = {
  repo: "yonda/cockpit",
  issueNumber: 1,
  issueTitle: "test issue",
  branch: "feature/1-test-issue",
};

describe("JobStore", () => {
  it("creates a queued job and emits an event", () => {
    const events: string[] = [];
    store.on("job", (job) => events.push(job.status));
    const job = store.create(fields);
    expect(job.status).toBe("queued");
    expect(job.id).toMatch(/^job-/);
    expect(events).toEqual(["queued"]);
  });

  it("persists jobs across reload", () => {
    const job = store.create(fields);
    store.transition(job.id, "running");

    const reloaded = new JobStore(dir);
    reloaded.loadAll();
    expect(reloaded.get(job.id)?.status).toBe("running");
  });

  it("rejects invalid transitions", () => {
    const job = store.create(fields);
    store.transition(job.id, "running");
    store.transition(job.id, "done");
    expect(() => store.transition(job.id, "running")).toThrow(/invalid transition/);
  });

  it("update patches fields without touching status", () => {
    const job = store.create(fields);
    store.update(job.id, { sessionId: "sess-1" });
    expect(store.get(job.id)?.sessionId).toBe("sess-1");
    expect(store.get(job.id)?.status).toBe("queued");
  });

  it("update rejects an explicit status key even when undefined", () => {
    const job = store.create(fields);
    expect(() =>
      store.update(job.id, { status: undefined, sessionId: "x" }),
    ).toThrow(/use transition/);
    expect(store.get(job.id)?.status).toBe("queued");
  });
});
