"use client";

import { useState } from "react";
import { Ban, Check, CircleDot, Loader2, Pause, X } from "lucide-react";
import type { Job, JobStatus } from "@/lib/jobs/types";
import { PendingInputPanel } from "./PendingInputPanel";

const statusConfig: Record<
  JobStatus,
  { icon: typeof Check; label: string; color: string; bg: string }
> = {
  queued: {
    icon: CircleDot,
    label: "queued",
    color: "text-[var(--signal-idle)]",
    bg: "bg-[var(--hairline)]/40 border-[var(--hairline)]",
  },
  running: {
    icon: Loader2,
    label: "running",
    color: "text-[var(--signal-info)]",
    bg: "bg-[var(--signal-info)]/10 border-[var(--signal-info)]/40",
  },
  waiting_input: {
    icon: Pause,
    label: "needs you",
    color: "text-[var(--signal-alert)]",
    bg: "bg-[var(--signal-alert)]/10 border-[var(--signal-alert)]/40",
  },
  done: {
    icon: Check,
    label: "done",
    color: "text-[var(--signal-ok)]",
    bg: "bg-[var(--signal-ok)]/10 border-[var(--signal-ok)]/40",
  },
  failed: {
    icon: X,
    label: "failed",
    color: "text-[var(--signal-alert)]",
    bg: "bg-[var(--signal-alert)]/10 border-[var(--signal-alert)]/40",
  },
  cancelled: {
    icon: Ban,
    label: "cancelled",
    color: "text-[var(--ink-faint)]",
    bg: "bg-[var(--hairline)]/20 border-[var(--hairline)]",
  },
};

function relativeTime(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function JobCard({ job }: { job: Job }) {
  const s = statusConfig[job.status];
  const Icon = s.icon;
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancellable = ["queued", "running", "waiting_input"].includes(job.status);

  const cancel = async () => {
    if (cancelBusy) return;
    setCancelBusy(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) setCancelError(json.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "request failed");
    } finally {
      setCancelBusy(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-2 border px-3 py-2.5 ${
        job.status === "waiting_input"
          ? "border-[var(--signal-alert)]/60"
          : "border-[var(--hairline)]"
      } bg-[var(--background)]`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--ink-muted)]">
            #{job.issueNumber}
          </span>
          <span className="truncate text-[13px] font-semibold text-[var(--ink)]">
            {job.issueTitle}
          </span>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${s.bg} ${s.color}`}
        >
          <Icon
            size={10}
            className={job.status === "running" ? "animate-spin" : undefined}
          />
          {s.label}
        </span>
      </div>

      {job.lastActivity ? (
        <div
          className="truncate font-mono text-[11px] text-[var(--ink-muted)]"
          title={job.lastActivity}
        >
          {job.lastActivity}
        </div>
      ) : null}

      {job.status === "waiting_input" && job.pendingInput ? (
        // key で pendingInput 交代時にパネルを再マウントし、
        // 前の質問の selections/busy/denyMessage/error を持ち越さない
        <PendingInputPanel key={job.pendingInput.id} job={job} />
      ) : null}

      {job.error ? (
        <div className="font-mono text-[11px] text-[var(--signal-alert)]">
          {job.error}
        </div>
      ) : null}

      {cancelError ? (
        <div className="font-mono text-[11px] text-[var(--signal-alert)]">
          {cancelError}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate font-mono text-[11px] text-[var(--ink-dim)]">
            {job.branch}
          </span>
          {job.prUrl ? (
            <a
              href={job.prUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 font-mono text-[11px] text-[var(--accent)] hover:underline"
            >
              PR ↗
            </a>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[10px] text-[var(--ink-muted)]">
            {relativeTime(job.updatedAt)}
          </span>
          {cancellable ? (
            <button
              type="button"
              disabled={cancelBusy}
              onClick={cancel}
              className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-faint)] transition hover:text-[var(--signal-alert)]"
            >
              cancel
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
