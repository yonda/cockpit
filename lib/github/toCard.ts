import type {
  Mergeable,
  PullRequestCard,
  Reviewer,
  ReviewerState,
  ReviewDecision,
  StatusCheckState,
} from "./types";

type RequestedReviewerUser = {
  __typename: "User";
  login: string;
  avatarUrl: string;
};

type RequestedReviewerTeam = {
  __typename: "Team";
  name: string;
  slug: string;
  avatarUrl: string;
};

type RequestedReviewer = RequestedReviewerUser | RequestedReviewerTeam | { __typename: string };

type LatestReview = {
  state: string;
  author: { login: string; avatarUrl: string } | null;
};

type GraphQLPullRequestNode = {
  __typename: string;
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  reviewDecision: ReviewDecision;
  mergeable: Mergeable;
  repository: { nameWithOwner: string };
  author: { login: string; avatarUrl: string } | null;
  comments: { totalCount: number };
  reviewThreads: { totalCount: number };
  viewerLatestReview: { state: string } | null;
  reviewRequests: {
    nodes: Array<{ requestedReviewer: RequestedReviewer | null }>;
  };
  latestReviews: {
    nodes: LatestReview[];
  };
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: StatusCheckState } | null;
      };
    }>;
  };
};

export type SearchPullRequestsResponse = {
  search: {
    issueCount: number;
    nodes: Array<GraphQLPullRequestNode | { __typename: string }>;
  };
};

function reviewStateFromGraphQL(state: string): ReviewerState {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    default:
      return "pending";
  }
}

function collectReviewers(node: GraphQLPullRequestNode): Reviewer[] {
  const byKey = new Map<string, Reviewer>();

  for (const review of node.latestReviews.nodes) {
    const author = review.author;
    if (!author) continue;
    const key = `user:${author.login}`;
    byKey.set(key, {
      key,
      displayName: author.login,
      avatarUrl: author.avatarUrl,
      isTeam: false,
      state: reviewStateFromGraphQL(review.state),
    });
  }

  for (const request of node.reviewRequests.nodes) {
    const reviewer = request.requestedReviewer;
    if (!reviewer) continue;
    if (reviewer.__typename === "User") {
      const user = reviewer as RequestedReviewerUser;
      const key = `user:${user.login}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        displayName: user.login,
        avatarUrl: user.avatarUrl,
        isTeam: false,
        state: "pending",
      });
    } else if (reviewer.__typename === "Team") {
      const team = reviewer as RequestedReviewerTeam;
      const key = `team:${team.slug}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        displayName: team.name,
        avatarUrl: team.avatarUrl,
        isTeam: true,
        state: "pending",
      });
    }
  }

  const priority: Record<ReviewerState, number> = {
    changes_requested: 0,
    pending: 1,
    commented: 2,
    approved: 3,
    dismissed: 4,
  };

  return Array.from(byKey.values()).sort(
    (a, b) => priority[a.state] - priority[b.state],
  );
}

export function toPullRequestCard(node: GraphQLPullRequestNode): PullRequestCard {
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    repositoryNameWithOwner: node.repository.nameWithOwner,
    authorLogin: node.author?.login ?? "ghost",
    authorAvatarUrl: node.author?.avatarUrl ?? "",
    isDraft: node.isDraft,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    additions: node.additions,
    deletions: node.deletions,
    reviewDecision: node.reviewDecision,
    mergeable: node.mergeable,
    statusCheckRollup:
      node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    commentCount: node.comments.totalCount,
    reviewThreadCount: node.reviewThreads.totalCount,
    viewerHasReviewed: node.viewerLatestReview !== null,
    viewerLatestReviewState:
      (node.viewerLatestReview?.state as PullRequestCard["viewerLatestReviewState"]) ??
      null,
    reviewers: collectReviewers(node),
  };
}

export function extractPullRequestCards(
  response: SearchPullRequestsResponse,
): PullRequestCard[] {
  return response.search.nodes
    .filter((node): node is GraphQLPullRequestNode => node.__typename === "PullRequest")
    .map(toPullRequestCard);
}
