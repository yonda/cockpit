import { Suspense } from "react";
import { SectionBoundary } from "@/app/_components/SectionBoundary";
import { SectionSkeleton } from "@/app/_components/Skeleton";
import { RangeTabs } from "@/app/_components/RangeTabs";
import { SourceTabs, type ActivitySource } from "@/app/_components/SourceTabs";
import {
  ActivityTimeline,
  type FeedEvent,
} from "@/app/_components/ActivityTimeline";
import { HintTooltip } from "@/app/_components/HintTooltip";
import { SectionErrorState } from "@/app/_components/ErrorState";
import {
  fetchActivityEvents,
  filterByRange,
  parseRange,
  rangeCutoffIso,
} from "@/lib/github/activity";
import { fetchClaudePromptEvents } from "@/lib/claude/activity";
import { fetchViewer } from "@/lib/github/fetchers";

export const dynamic = "force-dynamic";

function parseSource(value: string | undefined): ActivitySource {
  if (value === "github" || value === "claude") return value;
  return "all";
}

async function ActivityBoard({
  range,
  source,
}: {
  range: ReturnType<typeof parseRange>;
  source: ActivitySource;
}) {
  const { fromIso, toIso } = rangeCutoffIso(range);

  let githubEvents: FeedEvent[];
  let claudeEvents: FeedEvent[];
  try {
    [githubEvents, claudeEvents] = await Promise.all([
      source === "claude"
        ? Promise.resolve([])
        : fetchViewer().then((viewer) => fetchActivityEvents(viewer.login)),
      source === "github"
        ? Promise.resolve([])
        : fetchClaudePromptEvents(fromIso, toIso),
    ]);
  } catch (err) {
    return <SectionErrorState error={err} />;
  }

  const merged: FeedEvent[] = [...githubEvents, ...claudeEvents];
  merged.sort((a, b) => b.at.localeCompare(a.at));
  const filtered = filterByRange(merged, range);
  return <ActivityTimeline events={filtered} />;
}

export default async function ActivityPage(props: {
  searchParams: Promise<{ range?: string; source?: string }>;
}) {
  const searchParams = await props.searchParams;
  const range = parseRange(searchParams.range);
  const source = parseSource(searchParams.source);

  return (
    <div className="flex-1">
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pt-10 pb-24">
        <div className="flex items-baseline justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
            <h1 className="font-mono text-[18px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
              Activity
            </h1>
            <HintTooltip hint="github reviews & comments · claude code prompts you sent" />
          </div>
          <div className="flex items-center gap-3">
            <SourceTabs />
            <RangeTabs />
          </div>
        </div>

        <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />

        <SectionBoundary title="activity">
          <Suspense fallback={<SectionSkeleton />} key={`${range}:${source}`}>
            <ActivityBoard range={range} source={source} />
          </Suspense>
        </SectionBoundary>
      </main>
    </div>
  );
}
