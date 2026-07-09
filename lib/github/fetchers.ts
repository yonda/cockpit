import { env } from "@/lib/env";
import { graphql } from "./client";
import {
  buildSearchQuery,
  SEARCH_PULL_REQUESTS_QUERY,
  VIEWER_QUERY,
  VIEWER_STATUS_QUERY,
} from "./queries";
import { extractPullRequestCards, type SearchPullRequestsResponse } from "./toCard";
import type { PullRequestCard } from "./types";

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
