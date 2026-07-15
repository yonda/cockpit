import { env } from "@/lib/env";
import { graphql } from "./client";
import {
  buildRunStateQuery,
  buildSearchQuery,
  SEARCH_PULL_REQUESTS_QUERY,
  VIEWER_QUERY,
  VIEWER_STATUS_QUERY,
} from "./queries";
import { extractPullRequestCards, type SearchPullRequestsResponse } from "./toCard";
import type { GhIssueState, GhPullRequestState, PullRequestCard } from "./types";

async function search(
  role: "review-requested" | "author" | "reviewed-by",
): Promise<PullRequestCard[]> {
  const data = await graphql<SearchPullRequestsResponse>(SEARCH_PULL_REQUESTS_QUERY, {
    variables: { q: buildSearchQuery(role, env.githubOrg) },
  });
  return extractPullRequestCards(data);
}

export function fetchReviewRequested(): Promise<PullRequestCard[]> {
  return search("review-requested");
}

export function fetchMyPullRequests(): Promise<PullRequestCard[]> {
  return search("author");
}

/** 自分が過去にレビューを送っていて、まだ open な PR */
export function fetchReviewedByMeOpen(): Promise<PullRequestCard[]> {
  return search("reviewed-by");
}

export type Viewer = { login: string; avatarUrl: string };

export async function fetchViewer(): Promise<Viewer> {
  const data = await graphql<{ viewer: Viewer }>(VIEWER_QUERY, {
    revalidate: 3600,
    tags: ["viewer"],
  });
  return data.viewer;
}

export type ViewerStatus = {
  indicatesLimitedAvailability: boolean;
  message: string | null;
  expiresAt: string | null;
} | null;

/** busy 検知用。fetchViewer と違い 15 秒ポーリングで即反映したいので no-store */
export async function fetchViewerStatus(): Promise<ViewerStatus> {
  const data = await graphql<{ viewer: { status: ViewerStatus } }>(
    VIEWER_STATUS_QUERY,
  );
  return data.viewer.status;
}

type RunStateNode = {
  number: number;
  state: string;
  url: string;
  isDraft?: boolean;
  mergeable?: GhPullRequestState["mergeable"];
  reviewDecision?: GhPullRequestState["reviewDecision"];
};

type RunStateResponse = {
  repository: Record<string, RunStateNode | null> | null;
};

/**
 * 進捗ファイルのノードが参照する sub-issue/PR 番号をまとめて1リクエストで取得する。
 * issueNumbers/prNumbers が両方空なら GitHub に問い合わせず空の結果を返す。
 */
export async function fetchRunGithubState(
  repo: string,
  issueNumbers: number[],
  prNumbers: number[],
): Promise<{
  issues: Map<number, GhIssueState>;
  pullRequests: Map<number, GhPullRequestState>;
}> {
  const issues = new Map<number, GhIssueState>();
  const pullRequests = new Map<number, GhPullRequestState>();
  if (issueNumbers.length === 0 && prNumbers.length === 0) {
    return { issues, pullRequests };
  }

  const [owner, name] = repo.split("/");
  const data = await graphql<RunStateResponse>(buildRunStateQuery(issueNumbers, prNumbers), {
    variables: { owner, name },
  });
  const repository = data.repository;
  if (!repository) return { issues, pullRequests };

  for (const n of issueNumbers) {
    const node = repository[`i${n}`];
    if (node) issues.set(n, { number: node.number, state: node.state as GhIssueState["state"], url: node.url });
  }
  for (const n of prNumbers) {
    const node = repository[`p${n}`];
    if (node) {
      pullRequests.set(n, {
        number: node.number,
        state: node.state as GhPullRequestState["state"],
        isDraft: node.isDraft ?? false,
        mergeable: node.mergeable ?? "UNKNOWN",
        reviewDecision: node.reviewDecision ?? null,
        url: node.url,
      });
    }
  }
  return { issues, pullRequests };
}
