import { Suspense } from "react";
import { SectionBoundary } from "@/app/_components/SectionBoundary";
import { SectionSkeleton } from "@/app/_components/Skeleton";
import { PullRequestsBoard } from "@/app/_components/PullRequestsBoard";
import { HintTooltip } from "@/app/_components/HintTooltip";

export const dynamic = "force-dynamic";

export default function PullRequestsPage() {
  return (
    <div className="flex-1">
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pt-10 pb-24">
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
          <h1 className="font-mono text-[18px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
            Pull Requests
          </h1>
          <HintTooltip hint="needs you · working · parked — the full board" />
        </div>

        <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />

        <SectionBoundary title="pull requests">
          <Suspense fallback={<SectionSkeleton />}>
            <PullRequestsBoard />
          </Suspense>
        </SectionBoundary>
      </main>
    </div>
  );
}
