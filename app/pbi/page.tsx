import { HintTooltip } from "@/app/_components/HintTooltip";
import { PbiBoard } from "@/app/_components/PbiBoard";
import { SectionBoundary } from "@/app/_components/SectionBoundary";
import { SectionErrorState } from "@/app/_components/ErrorState";
import { fetchPbiIssues, type LaunchIssue } from "@/lib/github/issues";

export const dynamic = "force-dynamic";

export default async function PbiPage() {
  let issues: LaunchIssue[] = [];
  let issueError: unknown = null;
  try {
    issues = await fetchPbiIssues();
  } catch (err) {
    issueError = err;
  }

  return (
    <div className="flex-1">
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pt-10 pb-24">
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
          <h1 className="font-mono text-[18px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
            PBI
          </h1>
          <HintTooltip hint="PBI を発射 · エージェントが分解 · 承認したら sub-task を自走実装 · PR をレビュー&マージで次へ" />
        </div>
        <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />
        <SectionBoundary title="pbi">
          {issueError ? <SectionErrorState error={issueError} /> : null}
          <PbiBoard issues={issues} />
        </SectionBoundary>
      </main>
    </div>
  );
}
