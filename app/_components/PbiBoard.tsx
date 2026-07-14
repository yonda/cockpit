// app/_components/PbiBoard.tsx
"use client";

import { useState } from "react";
import { Zap } from "lucide-react";
import type { AssignedIssue } from "@/lib/repos/types";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { LiveIndicator } from "./useHerdrState";
import { PbiCard } from "./PbiCard";
import { usePbiState } from "./usePbiState";

const OPEN = new Set(["decomposing", "awaiting_approval", "executing"]);

type Segment = "active" | "done" | "all";

const issueKey = (repo: string, issueNumber: number) => `${repo}#${issueNumber}`;

export function PbiBoard({ issues }: { issues: AssignedIssue[] }) {
  const { result, jobsById, live } = usePbiState();
  const [firing, setFiring] = useState<string | null>(null);
  const [fireError, setFireError] = useState<string | null>(null);
  const [segment, setSegment] = useState<Segment>("active");

  const pbis = result.status === "ok" ? result.pbis : [];
  const activePbis = pbis.filter((p) => OPEN.has(p.status));
  const donePbis = pbis.filter((p) => !OPEN.has(p.status));
  const visiblePbis = segment === "all" ? pbis : segment === "active" ? activePbis : donePbis;
  const activeIssues = new Set(activePbis.map((p) => issueKey(p.repo, p.issueNumber)));

  const fire = async (issue: AssignedIssue) => {
    if (firing !== null) return;
    setFiring(issueKey(issue.repo, issue.issueNumber));
    setFireError(null);
    try {
      const res = await fetch("/api/pbi/fire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: issue.repo,
          issueNumber: issue.issueNumber,
          title: issue.title,
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) setFireError(json.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setFireError(err instanceof Error ? err.message : "request failed");
    } finally {
      setFiring(null);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">Candidate Issues</h2>
        {fireError ? <div className="font-mono text-[11px] text-[var(--signal-alert)]">{fireError}</div> : null}
        {issues.length === 0 ? (
          <EmptyState message="登録リポジトリに自分アサインの open issue はありません" />
        ) : (
          <div className="flex flex-col gap-2">
            {issues.map((issue) => {
              const key = issueKey(issue.repo, issue.issueNumber);
              const active = activeIssues.has(key);
              return (
                <div key={key} className="flex items-center justify-between gap-3 border border-[var(--hairline)] bg-[var(--background)] px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-[11px] text-[var(--ink-faint)]">{issue.repo}</span>
                    <span className="font-mono text-[11px] text-[var(--ink-muted)]">#{issue.issueNumber}</span>
                    <a href={issue.url} target="_blank" rel="noreferrer" className="truncate text-[13px] font-medium text-[var(--ink)] hover:text-[var(--accent)]">{issue.title}</a>
                  </div>
                  <button type="button" disabled={active || firing !== null} onClick={() => fire(issue)} className={`inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] transition ${active ? "cursor-default border-[var(--hairline)] text-[var(--ink-faint)]" : "border-[var(--accent)]/60 text-[var(--accent)] hover:bg-[var(--accent)]/10"}`}>
                    <Zap size={11} />
                    {active ? "in flight" : firing === key ? "firing…" : "launch"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">PBIs</h2>
          <div className="flex items-center gap-3">
            <div className="flex items-center border border-[var(--hairline)]">
              {(
                [
                  { key: "active", label: `active ${activePbis.length}` },
                  { key: "done", label: `done ${donePbis.length}` },
                  { key: "all", label: "all" },
                ] as const
              ).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSegment(key)}
                  className={`px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition ${segment === key ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "text-[var(--ink-faint)] hover:text-[var(--ink-muted)]"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <LiveIndicator live={live} />
          </div>
        </div>
        {result.status === "loading" ? (
          <EmptyState message="loading…" />
        ) : result.status === "error" ? (
          <ErrorState title="runner unreachable" message={`${result.message} — bin/service runner-status で確認`} />
        ) : pbis.length === 0 ? (
          <EmptyState message="まだ PBI はありません。候補 issue を launch してください" />
        ) : visiblePbis.length === 0 ? (
          <EmptyState message={segment === "active" ? "アクティブな PBI はありません" : "終了した PBI はありません"} />
        ) : (
          <div className="flex flex-col gap-3">
            {visiblePbis.map((pbi) => (
              <PbiCard key={pbi.id} pbi={pbi} jobsById={jobsById} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
