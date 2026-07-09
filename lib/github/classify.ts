import type { CardOrigin, PullRequestCard, Tier } from "./types";

export type ClassifiedCard = PullRequestCard & {
  origin: CardOrigin;
  tier: Tier;
};

export type ClassifiedBuckets = {
  now: { mine: ClassifiedCard[]; review: ClassifiedCard[] };
  soon: { mine: ClassifiedCard[]; review: ClassifiedCard[] };
  waiting: { mine: ClassifiedCard[]; review: ClassifiedCard[] };
};

export function classifyMinePR(pr: PullRequestCard): Tier {
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "now";
  if (pr.statusCheckRollup === "FAILURE" || pr.statusCheckRollup === "ERROR") return "now";
  if (pr.mergeable === "CONFLICTING") return "now";
  if (pr.isDraft) {
    // Draft のまま CI が通っている = Ready for review に切り替えるべき合図
    if (pr.statusCheckRollup === "SUCCESS") return "now";
    return "soon";
  }
  // Draft を解除したのにレビュアー未アサイン (リクエストもレビューもゼロ) =
  // まだボールは自分側にあるので Parked にしない
  if (pr.reviewers.length === 0) return "soon";
  return "waiting";
}

export function classifyReviewRequest(pr: PullRequestCard): Tier {
  if (pr.viewerHasReviewed) return "waiting";
  // CI 実行中はまだレビューするタイミングじゃないので「じきに」へ
  if (pr.statusCheckRollup === "PENDING") return "soon";
  return "now";
}

export function classify(
  mine: PullRequestCard[],
  review: PullRequestCard[],
  reviewedByMe: PullRequestCard[] = [],
): ClassifiedBuckets {
  const buckets: ClassifiedBuckets = {
    now: { mine: [], review: [] },
    soon: { mine: [], review: [] },
    waiting: { mine: [], review: [] },
  };

  for (const pr of mine) {
    const tier = classifyMinePR(pr);
    buckets[tier].mine.push({ ...pr, origin: "mine", tier });
  }

  const reviewIds = new Set<string>();
  for (const pr of review) {
    const tier = classifyReviewRequest(pr);
    buckets[tier].review.push({ ...pr, origin: "review", tier });
    reviewIds.add(pr.id);
  }

  // 自分が APPROVE したまま未マージのものを HOLD に。
  // review-requested クエリと重複するものは既に入っているのでスキップする
  for (const pr of reviewedByMe) {
    if (reviewIds.has(pr.id)) continue;
    if (pr.viewerLatestReviewState !== "APPROVED") continue;
    buckets.waiting.review.push({ ...pr, origin: "review", tier: "waiting" });
  }

  return buckets;
}
