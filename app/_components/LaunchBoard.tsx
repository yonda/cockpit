"use client";

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import type { LaunchIssue } from "@/lib/github/issues";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { JobCard } from "./JobCard";
import { LiveIndicator } from "./useHerdrState";
import { useInFlightAction } from "./useInFlightAction";
import { useJobsState } from "./useJobsState";

const ACTIVE = new Set(["queued", "running", "waiting_input"]);

export function LaunchBoard({ issues }: { issues: LaunchIssue[] }) {
  const { result, live } = useJobsState();
  // 成功時はガードを維持し、ポーリングが active を反映するまでボタンを disabled のまま保つ。
  const { busy: firing, run: runFire, reset: resetFiring } = useInFlightAction<number>({
    keepInFlightOnSuccess: true,
  });
  const [fireError, setFireError] = useState<string | null>(null);

  const jobs = result.status === "ok" ? result.jobs : [];
  const activeIssueNumbers = new Set(
    jobs.filter((j) => ACTIVE.has(j.status)).map((j) => j.issueNumber),
  );

  // ポーリングで発射対象が active 化したら firing を解除する。以降は disabled={active || ...}
  // の active 側が引き継ぐため、他 issue の launch を firing が永久にブロックしない。
  const firingBecameActive = firing !== null && activeIssueNumbers.has(firing);
  useEffect(() => {
    if (firingBecameActive) resetFiring();
  }, [firingBecameActive, resetFiring]);

  const fire = (issue: LaunchIssue) =>
    runFire(async () => {
      setFireError(null);
      try {
        const res = await fetch("/api/jobs/fire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            issueNumber: issue.number,
            issueTitle: issue.title,
          }),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!json.ok) {
          setFireError(json.error ?? `HTTP ${res.status}`);
          return false;
        }
        return true;
      } catch (err) {
        setFireError(err instanceof Error ? err.message : "request failed");
        return false;
      }
    }, issue.number);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
          Open Issues
        </h2>
        {fireError ? (
          <div className="font-mono text-[11px] text-[var(--signal-alert)]">
            {fireError}
          </div>
        ) : null}
        {issues.length === 0 ? (
          <EmptyState message="open issue はありません" />
        ) : (
          <div className="flex flex-col gap-2">
            {issues.map((issue) => {
              const active = activeIssueNumbers.has(issue.number);
              return (
                <div
                  key={issue.number}
                  className="flex items-center justify-between gap-3 border border-[var(--hairline)] bg-[var(--background)] px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-[11px] text-[var(--ink-muted)]">
                      #{issue.number}
                    </span>
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[13px] font-medium text-[var(--ink)] hover:text-[var(--accent)]"
                    >
                      {issue.title}
                    </a>
                    {issue.labels.map((label) => (
                      <span
                        key={label.name}
                        className="shrink-0 border border-[var(--hairline)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-muted)]"
                      >
                        {label.name}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={active || firing !== null}
                    onClick={() => fire(issue)}
                    className={`inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] transition ${
                      active
                        ? "cursor-default border-[var(--hairline)] text-[var(--ink-faint)]"
                        : "border-[var(--accent)]/60 text-[var(--accent)] hover:bg-[var(--accent)]/10"
                    }`}
                  >
                    <Zap size={11} />
                    {active ? "in flight" : firing === issue.number ? "firing…" : "launch"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
            Jobs
          </h2>
          <LiveIndicator live={live} />
        </div>
        {result.status === "loading" ? (
          <EmptyState message="loading…" />
        ) : result.status === "error" ? (
          <ErrorState
            title="runner unreachable"
            message={`${result.message} — bin/service runner-status で確認`}
          />
        ) : jobs.length === 0 ? (
          <EmptyState message="まだジョブはありません。Issue を launch してください" />
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
