import { HintTooltip } from "@/app/_components/HintTooltip";
import { LaunchBoard } from "@/app/_components/LaunchBoard";
import { SectionBoundary } from "@/app/_components/SectionBoundary";
import { SectionErrorState } from "@/app/_components/ErrorState";
import { fetchOpenIssues, type LaunchIssue } from "@/lib/github/issues";

export const dynamic = "force-dynamic";

export default async function LaunchPage() {
  let issues: LaunchIssue[] = [];
  let issueError: unknown = null;
  try {
    issues = await fetchOpenIssues();
  } catch (err) {
    issueError = err;
  }

  return (
    <div className="flex-1">
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pt-10 pb-24">
        <div className="flex items-baseline justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
            <h1 className="font-mono text-[18px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
              Launch Pad
            </h1>
            <HintTooltip hint="⚡ fire an issue · headless agent implements it in a worktree · answer permissions here · result lands as a draft PR" />
          </div>
        </div>

        <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />

        <SectionBoundary title="launch pad">
          {issueError ? <SectionErrorState error={issueError} /> : null}
          <LaunchBoard issues={issues} />
        </SectionBoundary>
      </main>
    </div>
  );
}
