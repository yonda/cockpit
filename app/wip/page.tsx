import { SectionBoundary } from "@/app/_components/SectionBoundary";
import { WipBoard } from "@/app/_components/WipBoard";
import { HintTooltip } from "@/app/_components/HintTooltip";

export const dynamic = "force-dynamic";

export default function WipPage() {
  return (
    <div className="flex-1">
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pt-10 pb-24">
        <div className="flex items-baseline justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
            <h1 className="font-mono text-[18px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
              Work in Progress
            </h1>
            <HintTooltip hint="every herdr agent and shell · needs you = blocked or done-unreviewed · live via SSE" />
          </div>
        </div>

        <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />

        <SectionBoundary title="work in progress">
          <WipBoard />
        </SectionBoundary>
      </main>
    </div>
  );
}
