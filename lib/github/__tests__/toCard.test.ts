import { describe, expect, it } from "vitest";
import { toPullRequestCard, type GraphQLPullRequestNode } from "../toCard";

function makeNode(overrides: Partial<GraphQLPullRequestNode> = {}): GraphQLPullRequestNode {
  return {
    __typename: "PullRequest",
    id: "PR_1",
    number: 1,
    title: "title",
    url: "https://github.com/owner/name/pull/1",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    additions: 0,
    deletions: 0,
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    headRefName: "feature/x",
    baseRefName: "main",
    isCrossRepository: false,
    headRepositoryOwner: { login: "owner" },
    repository: { nameWithOwner: "owner/name", defaultBranchRef: { name: "main" } },
    author: { login: "me", avatarUrl: "" },
    comments: { totalCount: 0 },
    reviewThreads: { totalCount: 0 },
    viewerLatestReview: null,
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [] },
    ...overrides,
  };
}

describe("toPullRequestCard のブランチ情報", () => {
  it("base がデフォルトブランチなら baseIsDefaultBranch は true", () => {
    const card = toPullRequestCard(makeNode());
    expect(card.headBranchLabel).toBe("feature/x");
    expect(card.baseIsDefaultBranch).toBe(true);
  });

  it("stacked PR のように base がデフォルト以外なら false", () => {
    const card = toPullRequestCard(makeNode({ baseRefName: "feature/base" }));
    expect(card.baseRefName).toBe("feature/base");
    expect(card.baseIsDefaultBranch).toBe(false);
  });

  it("デフォルトブランチが取れないときは true に倒して base を出さない", () => {
    const card = toPullRequestCard(
      makeNode({
        baseRefName: "develop",
        repository: { nameWithOwner: "owner/name", defaultBranchRef: null },
      }),
    );
    expect(card.baseIsDefaultBranch).toBe(true);
  });

  it("fork からの PR は head に owner を付ける", () => {
    const card = toPullRequestCard(
      makeNode({
        headRefName: "main",
        isCrossRepository: true,
        headRepositoryOwner: { login: "contributor" },
      }),
    );
    expect(card.headBranchLabel).toBe("contributor:main");
  });
});
