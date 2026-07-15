import { Suspense } from "react";
import { SectionBoundary } from "@/app/_components/SectionBoundary";
import { SectionSkeleton } from "@/app/_components/Skeleton";
import { ProgressLens } from "@/app/_components/ProgressLens";
import { HintTooltip } from "@/app/_components/HintTooltip";

export const dynamic = "force-dynamic";

export default function ProgressPage() {
  return (
    <div className="flex-1">
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pt-10 pb-24">
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
          <h1 className="font-mono text-[18px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
            Progress
          </h1>
          <HintTooltip hint="issue-driver runs · live status(進捗ファイル) × GitHub確定状態をjoin · escalated first" />
        </div>

        <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />

        <SectionBoundary title="progress">
          <Suspense fallback={<SectionSkeleton />}>
            <ProgressLens />
          </Suspense>
        </SectionBoundary>
      </main>
    </div>
  );
}
