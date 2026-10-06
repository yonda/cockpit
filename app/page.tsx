import { Suspense } from "react";
import { SectionBoundary } from "./_components/SectionBoundary";
import { SectionSkeleton } from "./_components/Skeleton";
import { AgentsTierCell } from "./_components/AgentsBoard";
import { PullRequestsTierCell } from "./_components/PullRequestsBoard";
import { TierBand } from "./_components/BoardTier";
import { BoardColumnHeader } from "./_components/BoardColumnHeader";
import { TodaySchedule } from "./_components/TodaySchedule";

export const dynamic = "force-dynamic";

// tier-first レイアウト: 行 = Needs You / Working、行の中に Agents / PRs。
// 狭い幅では Needs You (agents → prs) → Working (agents → prs) → Today の順に積まれる。
export default function Dashboard() {
  return (
    <div className="flex-1">
      <main className="mx-auto grid max-w-7xl grid-cols-1 gap-x-10 gap-y-14 px-4 pt-10 pb-24 sm:px-8 lg:grid-cols-[2.8fr_0.7fr]">
        <div className="flex flex-col gap-14">
          <TierBand
            tone="now"
            label="Needs You"
            hint="agents: blocked on your reply · done unreviewed / prs: changes-requested · ci-failed · conflict · approved, ready to merge · unreviewed request"
          >
            <SectionBoundary title="agents">
              <AgentsTierCell tier="needsYou" />
            </SectionBoundary>
            <SectionBoundary title="pull requests">
              <Suspense fallback={<SectionSkeleton />}>
                <PullRequestsTierCell tier="now" />
              </Suspense>
            </SectionBoundary>
          </TierBand>

          <TierBand
            tone="soon"
            label="Working"
            hint="agents: running right now / prs: your drafts · un-drafted but unassigned · review requests with ci running"
          >
            <SectionBoundary title="agents">
              <AgentsTierCell tier="working" />
            </SectionBoundary>
            <SectionBoundary title="pull requests">
              <Suspense fallback={<SectionSkeleton />}>
                <PullRequestsTierCell tier="soon" />
              </Suspense>
            </SectionBoundary>
          </TierBand>
        </div>

        {/* 2 列表示のときだけスクロールに追従させる。top はヘッダ (約 74px) + 余白。
            画面より高いときは列の中でスクロールできるようにする */}
        <div className="lg:sticky lg:top-[98px] lg:max-h-[calc(100vh-122px)] lg:self-start lg:overflow-y-auto">
          <SectionBoundary title="today">
            <div className="flex flex-col gap-6">
              <BoardColumnHeader
                title="Today"
                hint="google calendar · 07:00–21:00 timeline · red line = now · click an event to join its meet"
                hintAlign="right"
              />
              <Suspense fallback={<SectionSkeleton />}>
                <TodaySchedule />
              </Suspense>
            </div>
          </SectionBoundary>
        </div>
      </main>
    </div>
  );
}
