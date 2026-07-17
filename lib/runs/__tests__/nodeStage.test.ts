import { describe, expect, it } from "vitest";
import { deriveCondition, deriveStage, stageLabel } from "../nodeStage";
import type { JoinedNode } from "@/lib/github/runJoin";
import type { GhPullRequestState } from "@/lib/github/types";

function node(overrides: Partial<JoinedNode> = {}): JoinedNode {
  return {
    key: "t1",
    title: "サブタスク",
    dependsOn: [],
    liveStatus: "queued",
    subIssue: null,
    prNumber: null,
    escalation: null,
    githubIssue: null,
    githubPullRequest: null,
    ...overrides,
  };
}

function pr(overrides: Partial<GhPullRequestState> = {}): GhPullRequestState {
  return {
    number: 1,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    url: "https://example.test/pr/1",
    ...overrides,
  };
}

describe("deriveStage", () => {
  it("PR が MERGED なら merged (liveStatus より優先する)", () => {
    const n = node({ liveStatus: "implementing", githubPullRequest: pr({ state: "MERGED" }) });
    expect(deriveStage(n)).toBe("merged");
  });

  it("PR が存在すれば review (実装は出ている証拠)", () => {
    expect(deriveStage(node({ githubPullRequest: pr({ state: "OPEN" }) }))).toBe("review");
  });

  it("PR が CLOSED でも存在すれば review", () => {
    expect(deriveStage(node({ githubPullRequest: pr({ state: "CLOSED" }) }))).toBe("review");
  });

  it("PR が無く liveStatus が implementing なら implementing", () => {
    expect(deriveStage(node({ liveStatus: "implementing" }))).toBe("implementing");
  });

  it("PR が無く liveStatus が queued なら queued", () => {
    expect(deriveStage(node({ liveStatus: "queued" }))).toBe("queued");
  });

  it("blocked は段階を持たないので、進んだ証拠がなければ queued に落ちる", () => {
    expect(deriveStage(node({ liveStatus: "blocked" }))).toBe("queued");
  });

  it("blocked でも PR があれば review まで証明できる", () => {
    const n = node({ liveStatus: "blocked", githubPullRequest: pr({ state: "OPEN" }) });
    expect(deriveStage(n)).toBe("review");
  });

  it("PR 番号を持たないまま handed_off を名乗るノードは queued に落ちる (書き手側の記述漏れを可視化する)", () => {
    expect(deriveStage(node({ liveStatus: "handed_off" }))).toBe("queued");
  });

  it("PR 番号を持たないまま reviewing を名乗るノードは queued に落ちる", () => {
    expect(deriveStage(node({ liveStatus: "reviewing" }))).toBe("queued");
  });

  it("prNumber があっても GitHub 取得失敗で join できていなければ liveStatus だけで決まる", () => {
    const n = node({ liveStatus: "implementing", prNumber: 99, githubPullRequest: null });
    expect(deriveStage(n)).toBe("implementing");
  });
});

describe("deriveCondition", () => {
  it("PR が MERGED なら ok", () => {
    expect(deriveCondition(node({ githubPullRequest: pr({ state: "MERGED" }) }))).toBe("ok");
  });

  it("liveStatus が blocked なら blocked", () => {
    expect(deriveCondition(node({ liveStatus: "blocked" }))).toBe("blocked");
  });

  it("PR が CONFLICTING なら blocked", () => {
    const n = node({
      liveStatus: "implementing",
      githubPullRequest: pr({ mergeable: "CONFLICTING" }),
    });
    expect(deriveCondition(n)).toBe("blocked");
  });

  it("平常時は normal", () => {
    expect(deriveCondition(node({ liveStatus: "implementing" }))).toBe("normal");
  });
});

describe("stageLabel", () => {
  it("blocked は条件＠段階で表す", () => {
    expect(stageLabel("queued", "blocked")).toBe("blocked @ queued");
    expect(stageLabel("review", "blocked")).toBe("blocked @ review");
  });

  it("blocked でなければ段階名をそのまま出す", () => {
    expect(stageLabel("implementing", "normal")).toBe("implementing");
    expect(stageLabel("merged", "ok")).toBe("merged");
  });
});
