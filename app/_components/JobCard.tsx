"use client";

import { useState } from "react";
import { Ban, Check, CircleDot, Loader2, Pause, X } from "lucide-react";
import type { Job, JobStatus, PendingInput } from "@/lib/jobs/types";

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

/** permission の内容を人間が判断できる 1 行に要約する */
function summarizeInput(pending: PendingInput): string {
  const input = pending.input as Record<string, unknown> | null;
  if (pending.toolName === "Bash" && typeof input?.command === "string") {
    return input.command;
  }
  if (typeof input?.file_path === "string") return input.file_path;
  return JSON.stringify(input).slice(0, 300);
}

type QuestionInput = {
  questions?: Array<{
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

function PendingInputPanel({ job }: { job: Job }) {
  const pending = job.pendingInput!;
  const [busy, setBusy] = useState(false);
  const [denyMessage, setDenyMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const respond = async (response: unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputId: pending.id, response }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) setError(json.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  };

  if (pending.kind === "question") {
    const questions = (pending.input as QuestionInput).questions ?? [];
    // MVP: 最初の質問の選択肢をボタンで出す (単一質問が実際のほぼ全ケース)
    const q = questions[0];
    return (
      <div className="flex flex-col gap-2 border border-[var(--signal-alert)]/40 bg-[var(--signal-alert)]/5 p-3">
        <div className="text-[13px] font-semibold text-[var(--ink)]">
          {q?.question ?? "エージェントからの質問"}
        </div>
        <div className="flex flex-wrap gap-2">
          {(q?.options ?? []).map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={busy}
              title={option.description}
              onClick={() => respond({ kind: "answers", answers: [[option.label]] })}
              className="border border-[var(--hairline-strong)] px-2.5 py-1 font-mono text-[12px] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              {option.label}
            </button>
          ))}
        </div>
        {error ? (
          <div className="font-mono text-[11px] text-[var(--signal-alert)]">
            {error}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border border-[var(--signal-alert)]/40 bg-[var(--signal-alert)]/5 p-3">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--signal-alert)]">
        permission · {pending.toolName}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] text-[var(--ink)]">
        {summarizeInput(pending)}
      </pre>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => respond({ kind: "allow" })}
          className="border border-[var(--signal-ok)]/60 px-2.5 py-1 font-mono text-[12px] text-[var(--signal-ok)] transition hover:bg-[var(--signal-ok)]/10"
        >
          許可
        </button>
        <input
          value={denyMessage}
          onChange={(e) => setDenyMessage(e.target.value)}
          placeholder="拒否理由 (任意)"
          aria-label="拒否理由"
          className="min-w-0 flex-1 border border-[var(--hairline)] bg-transparent px-2 py-1 font-mono text-[12px] text-[var(--ink)]"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            respond({ kind: "deny", message: denyMessage || "拒否されました" })
          }
          className="border border-[var(--signal-alert)]/60 px-2.5 py-1 font-mono text-[12px] text-[var(--signal-alert)] transition hover:bg-[var(--signal-alert)]/10"
        >
          拒否
        </button>
      </div>
      {error ? (
        <div className="font-mono text-[11px] text-[var(--signal-alert)]">
          {error}
        </div>
      ) : null}
    </div>
  );
}

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
        <PendingInputPanel job={job} />
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
