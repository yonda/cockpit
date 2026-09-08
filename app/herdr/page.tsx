import { SectionBoundary } from "@/app/_components/SectionBoundary";
import { HerdrMirror } from "@/app/_components/HerdrMirror";
import { HintTooltip } from "@/app/_components/HintTooltip";

export const dynamic = "force-dynamic";

export default function HerdrPage() {
  return (
    <div className="flex-1">
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pt-10 pb-24">
        <div className="flex items-baseline justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
            <h1 className="font-mono text-[18px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
              Herdr
            </h1>
            <HintTooltip hint="herdr のサイドバーと同じ並び · pane を選ぶと画面とプロンプト欄 · j/k で移動 · live via SSE" />
          </div>
        </div>

        <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />

        <SectionBoundary title="herdr">
          <HerdrMirror />
        </SectionBoundary>
      </main>
    </div>
  );
}
