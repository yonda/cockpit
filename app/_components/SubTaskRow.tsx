// app/_components/SubTaskRow.tsx
"use client";

import { useState } from "react";
import type { Job } from "@/lib/jobs/types";
import type { PbiEscalation, SubTaskRecord } from "@/lib/pbi/types";
import { PendingInputPanel } from "./PendingInputPanel";
import { useInFlightAction } from "./useInFlightAction";

const stateBadge: Record<SubTaskRecord["state"], { label: string; cls: string }> = {
  pending: { label: "待機", cls: "text-[var(--ink-faint)] border-[var(--hairline)]" },
  running: { label: "実行中", cls: "text-[var(--signal-info)] border-[var(--signal-info)]/40" },
  in_review: { label: "レビュー待ち", cls: "text-[var(--signal-alert)] border-[var(--signal-alert)]/40" },
  merged: { label: "merged", cls: "text-[var(--signal-ok)] border-[var(--signal-ok)]/40" },
  done_no_pr: { label: "完了(PRなし)", cls: "text-[var(--signal-ok)] border-[var(--signal-ok)]/40" },
  failed: { label: "failed", cls: "text-[var(--signal-alert)] border-[var(--signal-alert)]/40" },
  skipped: { label: "skip", cls: "text-[var(--ink-faint)] border-[var(--hairline)]" },
};

export function SubTaskRow({
  pbiId,
  task,
  job,
  escalations,
}: {
  pbiId: string;
  task: SubTaskRecord;
  job: Job | undefined;
  escalations: PbiEscalation[];
}) {
  const { isBusy: busy, run: runGuarded } = useInFlightAction();
  const [error, setError] = useState<string | null>(null);
  const badge = stateBadge[task.state];
  const hasReviewComments = escalations.some(
    (e) => e.kind === "review_comments" && e.subTaskKey === task.key,
  );

  const act = (path: string) =>
    runGuarded(async () => {
      setError(null);
      try {
        const res = await fetch(
          `/api/pbi/${pbiId}/task/${task.key}/${path}`,
          { method: "POST" },
        );
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!json.ok) {
          setError(json.error ?? `HTTP ${res.status}`);
          return false;
        }
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "request failed");
        return false;
      }
    });

  return (
    <div className="flex flex-col gap-1 border-l-2 border-[var(--hairline)] pl-2">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="font-mono text-[var(--ink-muted)]">{task.key}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{task.title}</span>
        <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] ${badge.cls}`}>
          {badge.label}
        </span>
      </div>

      {(task.state === "running" || task.state === "in_review") && job?.lastActivity ? (
        <div className="truncate font-mono text-[11px] text-[var(--ink-muted)]" title={job.lastActivity}>
          {job.lastActivity}
        </div>
      ) : null}

      {(task.state === "running" || task.state === "in_review") && job?.status === "waiting_input" && job.pendingInput ? (
        <PendingInputPanel key={job.pendingInput.id} job={job} />
      ) : null}

      {task.state === "in_review" ? (
        <div className="flex items-center gap-2 text-[11px]">
          {task.prUrl ? (
            <a href={task.prUrl} target="_blank" rel="noreferrer" className="font-mono text-[var(--accent)] hover:underline">
              PR ↗
            </a>
          ) : null}
          {hasReviewComments ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => act("review-reply")}
              className="border border-[var(--signal-alert)]/60 px-2 py-0.5 font-mono text-[10px] text-[var(--signal-alert)] hover:bg-[var(--signal-alert)]/10"
            >
              💬 コメント対応を発射
            </button>
          ) : null}
        </div>
      ) : null}

      {task.state === "failed" ? (
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy} onClick={() => act("retry")} className="border border-[var(--accent)]/60 px-2 py-0.5 font-mono text-[10px] text-[var(--accent)] hover:bg-[var(--accent)]/10">
            リトライ
          </button>
          <button type="button" disabled={busy} onClick={() => act("done")} className="border border-[var(--signal-ok)]/60 px-2 py-0.5 font-mono text-[10px] text-[var(--signal-ok)] hover:bg-[var(--signal-ok)]/10">
            完了扱い
          </button>
          <button type="button" disabled={busy} onClick={() => act("skip")} className="border border-[var(--hairline)] px-2 py-0.5 font-mono text-[10px] text-[var(--ink-muted)] hover:border-[var(--ink)]">
            スキップ
          </button>
        </div>
      ) : null}

      {task.state === "pending" && task.dependsOn.length > 0 ? (
        <div className="font-mono text-[10px] text-[var(--ink-faint)]">依存: {task.dependsOn.join(", ")}</div>
      ) : null}

      {error ? <div className="font-mono text-[10px] text-[var(--signal-alert)]">{error}</div> : null}
    </div>
  );
}
