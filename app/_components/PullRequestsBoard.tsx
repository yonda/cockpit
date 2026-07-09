import { cache } from "react";
import {
  fetchMyPullRequests,
  fetchReviewRequested,
  fetchReviewedByMeOpen,
} from "@/lib/github/fetchers";
import { classify } from "@/lib/github/classify";
import { TierSection, SubGroup } from "./Section";
import { EmptyRow } from "./EmptyState";
import { SectionErrorState } from "./ErrorState";
import { SourceHeader } from "./BoardTier";
import { NowWatcher, type NowNotifyCard } from "./NowWatcher";

// Board では tier ごとに別の Suspense island から呼ばれるため、
// 同一リクエスト内でのフェッチを cache で 1 回にまとめる
const fetchBuckets = cache(async () => {
  const [mine, review, reviewedByMe] = await Promise.all([
    fetchMyPullRequests(),
    fetchReviewRequested(),
    fetchReviewedByMeOpen(),
  ]);
  return classify(mine, review, reviewedByMe);
});

function nowSection(
  buckets: Awaited<ReturnType<typeof fetchBuckets>>,
  stackSubgroups = false,
) {
  const nowTotal = buckets.now.mine.length + buckets.now.review.length;
  return (
    <TierSection
      tone="now"
      label="Needs You"
      totalCount={nowTotal}
      hint="changes-requested · ci-failed · conflict · draft with green ci · unreviewed request"
      subgroups={[
        { title: "yours · needs work", cards: buckets.now.mine },
        { title: "review requests · open", cards: buckets.now.review },
      ]}
      emptyMessage="all clear · nothing to action right now"
      stackSubgroups={stackSubgroups}
    />
  );
}

function soonSection(
  buckets: Awaited<ReturnType<typeof fetchBuckets>>,
  stackSubgroups = false,
) {
  const soonTotal = buckets.soon.mine.length + buckets.soon.review.length;
  return (
    <TierSection
      tone="soon"
      label="Working"
      totalCount={soonTotal}
      hint="your drafts · un-drafted but no reviewer assigned · review requests with ci still running"
      subgroups={[
        { title: "yours · draft / no reviewer", cards: buckets.soon.mine },
        { title: "review requests · ci running", cards: buckets.soon.review },
      ]}
      emptyMessage="nothing queued up"
      stackSubgroups={stackSubgroups}
    />
  );
}

function nowNotifyCards(
  buckets: Awaited<ReturnType<typeof fetchBuckets>>,
): NowNotifyCard[] {
  return [
    ...buckets.now.mine.map((c) => ({
      id: c.id,
      title: c.title,
      repo: c.repositoryNameWithOwner,
      url: c.url,
      bucket: "mine" as const,
    })),
    ...buckets.now.review.map((c) => ({
      id: c.id,
      title: c.title,
      repo: c.repositoryNameWithOwner,
      url: c.url,
      bucket: "review" as const,
    })),
  ];
}

const PR_TIER_META = {
  now: {
    subgroups: (b: Awaited<ReturnType<typeof fetchBuckets>>) => [
      { title: "yours · needs work", cards: b.now.mine },
      { title: "review requests · open", cards: b.now.review },
    ],
    emptyMessage: "all clear · nothing to action right now",
  },
  soon: {
    subgroups: (b: Awaited<ReturnType<typeof fetchBuckets>>) => [
      { title: "yours · draft / no reviewer", cards: b.soon.mine },
      { title: "review requests · ci running", cards: b.soon.review },
    ],
    emptyMessage: "nothing queued up",
  },
} as const;

// tier-first Board の Pull Requests セル。tier 見出しは TierBand 側が持つ。
export async function PullRequestsTierCell({ tier }: { tier: "now" | "soon" }) {
  let buckets;
  try {
    buckets = await fetchBuckets();
  } catch (err) {
    return (
      <section className="flex flex-col gap-4">
        <SourceHeader title="Pull Requests" />
        <SectionErrorState error={err} />
      </section>
    );
  }
  const meta = PR_TIER_META[tier];
  const subgroups = meta.subgroups(buckets);
  const total = subgroups.reduce((n, g) => n + g.cards.length, 0);

  return (
    <section className="flex flex-col gap-4">
      {tier === "now" ? <NowWatcher cards={nowNotifyCards(buckets)} /> : null}
      <SourceHeader title="Pull Requests" count={total} />

      {total === 0 ? (
        <EmptyRow message={meta.emptyMessage} />
      ) : (
        <div className="flex flex-col gap-6">
          {subgroups.map((group) => (
            <SubGroup key={group.title} title={group.title} cards={group.cards} />
          ))}
        </div>
      )}
    </section>
  );
}

// Pull Requests タブ用: Hold まで含めた全量
export async function PullRequestsBoard() {
  let buckets;
  try {
    buckets = await fetchBuckets();
  } catch (err) {
    return <SectionErrorState error={err} />;
  }
  const waitingTotal =
    buckets.waiting.mine.length + buckets.waiting.review.length;

  return (
    <div className="flex flex-col gap-14">
      {nowSection(buckets)}
      {soonSection(buckets)}
      <TierSection
        tone="hold"
        label="Parked"
        totalCount={waitingTotal}
        hint="awaiting reviewer · approved-by-you not merged"
        subgroups={[
          { title: "yours · waiting", cards: buckets.waiting.mine },
          { title: "approved by you · not merged", cards: buckets.waiting.review },
        ]}
        emptyMessage="nothing on hold"
      />
    </div>
  );
}
