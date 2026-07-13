import { describe, expect, it } from "vitest";
import type { Job } from "@/lib/jobs/types";
import type { HerdrPane } from "@/lib/herdr/types";
import { buildSessionToJob, planPaneNotify } from "../paneNotify";

function pane(over: Partial<HerdrPane> = {}): HerdrPane {
  return {
    paneId: "w1:p2",
    tabId: "w1:t2",
    workspaceId: "w1",
    agent: "claude",
    agentStatus: "blocked",
    cwd: "~/wt/job",
    foregroundCwd: null,
    focused: false,
    sessionId: "sess-1",
    recap: null,
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    repo: "yonda/cockpit",
    issueNumber: 62,
    issueTitle: "dogfood task",
    branch: "feature/62-x",
    kind: "implement",
    worktreePath: "/wt/job",
    status: "running",
    sessionId: "sess-1",
    pendingInput: null,
    prUrl: null,
    noChanges: false,
    error: null,
    lastActivity: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("buildSessionToJob", () => {
  it("sessionId を持つ active ジョブだけを索引する", () => {
    const map = buildSessionToJob([
      job({ id: "a", sessionId: "s1", status: "running" }),
      job({ id: "b", sessionId: null, status: "running" }),
    ]);
    expect(map.get("s1")?.id).toBe("a");
    expect(map.size).toBe(1);
  });

  it("終端ジョブ (done/failed/cancelled) は除外する", () => {
    const map = buildSessionToJob([
      job({ id: "d", sessionId: "s2", status: "done" }),
      job({ id: "f", sessionId: "s3", status: "failed" }),
      job({ id: "c", sessionId: "s4", status: "cancelled" }),
      job({ id: "w", sessionId: "s5", status: "waiting_input" }),
    ]);
    expect(map.size).toBe(1);
    expect(map.get("s5")?.id).toBe("w");
  });
});

describe("planPaneNotify", () => {
  it("ジョブ紐づきペインの blocked → ジョブ単位の escalation", () => {
    const plan = planPaneNotify(pane({ agentStatus: "blocked" }), job(), "cockpit");
    expect(plan?.title).toBe("JOB · #62 — waiting for you");
    expect(plan?.body).toBe("dogfood task");
    expect(plan?.sound).toBe("needsYou");
    expect(plan?.focus).toEqual({ workspaceId: "w1", tabId: "w1:t2" });
  });

  it("ジョブ紐づきペインの done → 鳴らさない (JobNotifyWatcher が担う)", () => {
    expect(planPaneNotify(pane({ agentStatus: "done" }), job(), "cockpit")).toBeNull();
  });

  it("個人ペイン (ジョブ無し) の blocked → 従来の汎用通知", () => {
    const plan = planPaneNotify(
      pane({ agentStatus: "blocked", recap: { title: "my task" } as never }),
      undefined,
      "Sentry",
    );
    expect(plan?.title).toBe("AGENT · Sentry — waiting for you");
    expect(plan?.body).toBe("my task");
  });

  it("個人ペインの done → 従来どおり done 通知", () => {
    const plan = planPaneNotify(
      pane({ agentStatus: "done" }),
      undefined,
      "Sentry",
    );
    expect(plan?.title).toBe("AGENT · Sentry — done");
    expect(plan?.sound).toBe("done");
  });

  it("blocked/done 以外は null", () => {
    expect(planPaneNotify(pane({ agentStatus: "working" }), job(), "x")).toBeNull();
  });

  it("終端ジョブのペインは buildSessionToJob で除外され個人ペイン扱いになる", () => {
    // 終端ジョブは索引に入らないため planPaneNotify には job=undefined で渡る
    const map = buildSessionToJob([job({ sessionId: "sess-1", status: "failed" })]);
    const linked = map.get("sess-1");
    const plan = planPaneNotify(
      pane({ agentStatus: "blocked", sessionId: "sess-1" }),
      linked,
      "cockpit",
    );
    expect(plan?.title).toBe("AGENT · cockpit — waiting for you"); // JOB ではない
  });
});
