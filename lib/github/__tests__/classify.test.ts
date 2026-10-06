import { describe, expect, it } from "vitest";
import { classify, classifyMinePR, classifyReviewRequest } from "../classify";
import type { PullRequestCard } from "../types";

function makePR(overrides: Partial<PullRequestCard> = {}): PullRequestCard {
  return {
    id: "PR_1",
    number: 1,
    title: "title",
    url: "https://github.com/owner/name/pull/1",
    repositoryNameWithOwner: "owner/name",
    headBranchLabel: "feature/x",
    baseRefName: "main",
    defaultBranchName: "main",
    authorLogin: "me",
    authorAvatarUrl: "",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    additions: 0,
    deletions: 0,
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    statusCheckRollup: "SUCCESS",
    commentCount: 0,
    reviewThreadCount: 0,
    viewerHasReviewed: false,
    viewerLatestReviewState: null,
    reviewers: [
      { key: "alice", displayName: "alice", avatarUrl: "", isTeam: false, state: "pending" },
    ],
    ...overrides,
  };
}

describe("classifyMinePR", () => {
  it("Approve 済みで CI 成功ならマージ待ちとして now", () => {
    expect(classifyMinePR(makePR({ reviewDecision: "APPROVED" }))).toBe("now");
  });

  it("Approve 済みで CI なしでも now", () => {
    expect(
      classifyMinePR(makePR({ reviewDecision: "APPROVED", statusCheckRollup: null })),
    ).toBe("now");
  });

  it("Approve 済みでも CI 実行中なら soon", () => {
    expect(
      classifyMinePR(makePR({ reviewDecision: "APPROVED", statusCheckRollup: "PENDING" })),
    ).toBe("soon");
  });

  it("レビュー待ちは soon", () => {
    expect(classifyMinePR(makePR())).toBe("soon");
  });
});

describe("classifyReviewRequest", () => {
  it("未レビューで CI 成功なら now", () => {
    expect(classifyReviewRequest(makePR())).toBe("now");
  });

  it("CI 実行中なら soon", () => {
    expect(classifyReviewRequest(makePR({ statusCheckRollup: "PENDING" }))).toBe("soon");
  });

  it("レビュー済みなら soon", () => {
    expect(classifyReviewRequest(makePR({ viewerHasReviewed: true }))).toBe("soon");
  });
});

describe("classify", () => {
  it("自分が Approve したまま未マージの PR は soon.review に入る", () => {
    const pr = makePR({ id: "PR_2", viewerLatestReviewState: "APPROVED" });
    const buckets = classify([], [], [pr]);
    expect(buckets.soon.review.map((c) => c.id)).toEqual(["PR_2"]);
  });
});
