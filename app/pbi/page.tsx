import { HintTooltip } from "@/app/_components/HintTooltip";
import { PbiBoard } from "@/app/_components/PbiBoard";
import { SectionBoundary } from "@/app/_components/SectionBoundary";

export const dynamic = "force-dynamic";

export default function PbiPage() {
  return (
    <div className="flex-1">
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pt-10 pb-24">
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
          <h1 className="font-mono text-[18px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
            PBI
          </h1>
          <HintTooltip hint="発射済み PBI の状態 · sub-task を自走実装 · PR をレビュー&マージで次へ · 発射は Launch タブから" />
        </div>
        <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />
        <SectionBoundary title="pbi">
          <PbiBoard />
        </SectionBoundary>
      </main>
    </div>
  );
}
