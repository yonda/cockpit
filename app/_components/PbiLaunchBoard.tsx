// app/_components/PbiLaunchBoard.tsx
"use client";

import { useState } from "react";
import { Zap } from "lucide-react";
import type { AssignedIssue } from "@/lib/repos/types";
import { EmptyState } from "./EmptyState";
import { usePbiState } from "./usePbiState";
import { isPbiOpen } from "@/lib/pbi/types";

const issueKey = (repo: string, issueNumber: number) => `${repo}#${issueNumber}`;

export function PbiLaunchBoard({ issues }: { issues: AssignedIssue[] }) {
  const { result } = usePbiState();
  const [firing, setFiring] = useState<string | null>(null);
  const [fireError, setFireError] = useState<string | null>(null);

  const pbis = result.status === "ok" ? result.pbis : [];
  const activeIssues = new Set(
    pbis.filter((p) => isPbiOpen(p.status)).map((p) => issueKey(p.repo, p.issueNumber)),
  );

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
    <section className="flex flex-col gap-3">
      <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
        Candidate Issues
      </h2>
      {fireError ? (
        <div className="font-mono text-[11px] text-[var(--signal-alert)]">{fireError}</div>
      ) : null}
      {issues.length === 0 ? (
        <EmptyState message="登録リポジトリに自分アサインの open issue はありません" />
      ) : (
        <div className="flex flex-col gap-2">
          {issues.map((issue) => {
            const key = issueKey(issue.repo, issue.issueNumber);
            const active = activeIssues.has(key);
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-3 border border-[var(--hairline)] bg-[var(--background)] px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-[var(--ink-faint)]">
                    {issue.repo}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--ink-muted)]">
                    #{issue.issueNumber}
                  </span>
                  <a
                    href={issue.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-[13px] font-medium text-[var(--ink)] hover:text-[var(--accent)]"
                  >
                    {issue.title}
                  </a>
                </div>
                <button
                  type="button"
                  disabled={active || firing !== null}
                  onClick={() => fire(issue)}
                  className={`inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] transition ${active ? "cursor-default border-[var(--hairline)] text-[var(--ink-faint)]" : "border-[var(--accent)]/60 text-[var(--accent)] hover:bg-[var(--accent)]/10"}`}
                >
                  <Zap size={11} />
                  {active ? "in flight" : firing === key ? "firing…" : "launch"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
