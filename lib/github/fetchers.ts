import { env } from "@/lib/env";
import { graphql } from "./client";
import {
  buildRunStateQuery,
  buildSearchQuery,
  type RunStateRefs,
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

/** repository エイリアス(r<i>)ごとに、番号エイリアス(i<N>/p<N>)を持つ */
type RunStateResponse = Record<string, Record<string, RunStateNode | null> | null>;

export type RunGithubState = {
  issues: Map<string, GhIssueState>;
  pullRequests: Map<string, GhPullRequestState>;
};

/** run は複数リポジトリにまたがりうるので、番号だけでは一意にならない */
export function githubRefKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/**
 * 進捗ファイルのノードが参照する sub-issue/PR 番号を、リポジトリ single/複数を問わず
 * まとめて1リクエストで取得する。結果は githubRefKey(repo, number) をキーに引ける。
 * 参照番号が1つも無ければ GitHub に問い合わせず空の結果を返す。
 *
 * 解決できなかった参照(削除済み・番号違い等)はエラーにせず結果の Map に載せないだけにする。
 * 1つの壊れた参照で run 全体の GitHub 状態を失わないため(fail-soft)。
 */
export async function fetchRunGithubState(refs: RunStateRefs[]): Promise<RunGithubState> {
  const issues = new Map<string, GhIssueState>();
  const pullRequests = new Map<string, GhPullRequestState>();

  const targets = refs.filter((r) => r.issueNumbers.length > 0 || r.prNumbers.length > 0);
  if (targets.length === 0) return { issues, pullRequests };

  const { query, variables } = buildRunStateQuery(targets);
  const data = await graphql<RunStateResponse>(query, { variables, allowPartialData: true });

  targets.forEach((ref, i) => {
    const repository = data[`r${i}`];
    if (!repository) return;

    for (const n of ref.issueNumbers) {
      const node = repository[`i${n}`];
      if (node) {
        issues.set(githubRefKey(ref.repo, n), {
          number: node.number,
          state: node.state as GhIssueState["state"],
          url: node.url,
        });
      }
    }
    for (const n of ref.prNumbers) {
      const node = repository[`p${n}`];
      if (node) {
        pullRequests.set(githubRefKey(ref.repo, n), {
          number: node.number,
          state: node.state as GhPullRequestState["state"],
          isDraft: node.isDraft ?? false,
          mergeable: node.mergeable ?? "UNKNOWN",
          reviewDecision: node.reviewDecision ?? null,
          url: node.url,
        });
      }
    }
  });

  return { issues, pullRequests };
}
