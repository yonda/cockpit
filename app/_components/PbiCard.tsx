// app/_components/PbiCard.tsx
"use client";

import { useEffect, useState } from "react";
import type { Job } from "@/lib/jobs/types";
import type { PbiJob } from "@/lib/pbi/types";
import { SubTaskRow } from "./SubTaskRow";
import { useInFlightAction } from "./useInFlightAction";

const statusLabel: Record<PbiJob["status"], string> = {
  decomposing: "分解中",
  awaiting_approval: "承認待ち",
  executing: "実行中",
  completed: "完了",
  failed: "失敗",
  cancelled: "中止",
};

async function postAction(path: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { ok: boolean; error?: string };
    return json.ok ? null : json.error ?? `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : "request failed";
  }
}

export function PbiCard({ pbi, jobsById }: { pbi: PbiJob; jobsById: Map<string, Job> }) {
  // 成功時はガードを保持し（ボタンを押せないまま保つ）、ポーリングで pbi.status /
  // pbi.paused の変化を検知するまで再有効化しない。失敗時のみ即解除する。
  const { isBusy: busy, run: runGuarded, reset } = useInFlightAction({
    keepInFlightOnSuccess: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  const run = (path: string, body?: unknown) =>
    runGuarded(async () => {
      setError(null);
      const err = await postAction(path, body);
      setError(err);
      return err === null;
    });

  // approve / revise / reject / pause / resume / cancel はいずれも成功すると
  // ポーリングで pbi.status か pbi.paused が変化する。その変化を検知したらガードを解除。
  useEffect(() => {
    reset();
  }, [pbi.status, pbi.paused, reset]);

  const mergedCount = pbi.subTasks.filter((t) => ["merged", "done_no_pr", "skipped"].includes(t.state)).length;
  const terminal = ["completed", "failed", "cancelled"].includes(pbi.status);

  return (
    <div className={`flex flex-col gap-2 border px-3 py-2.5 ${terminal ? "border-[var(--hairline)] opacity-70" : "border-[var(--hairline-strong)]"} bg-[var(--background)]`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-[var(--ink-faint)]" title={pbi.repo}>{pbi.repo}</span>
          <span className="font-mono text-[11px] text-[var(--ink-muted)]">#{pbi.issueNumber}</span>
          <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{pbi.title}</span>
        </div>
        <span className="shrink-0 border border-[var(--hairline)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-muted)]">
          {statusLabel[pbi.status]}{pbi.status === "executing" ? ` ${mergedCount}/${pbi.subTasks.length}` : ""}
        </span>
      </div>

      {pbi.status === "decomposing" ? (
        <div className="font-mono text-[12px] text-[var(--ink-muted)]">分解中…</div>
      ) : null}

      {pbi.status === "awaiting_approval" ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            {pbi.subTasks.map((t) => (
              <div key={t.key} className="border-l-2 border-[var(--signal-ok)]/50 pl-2 text-[12px]">
                <span className="font-mono text-[var(--ink-muted)]">{t.key}</span> {t.title}
                <span className="text-[var(--ink-faint)]"> → {t.deliverable}{t.dependsOn.length ? ` ・依存 ${t.dependsOn.join(",")}` : ""}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => run(`/api/pbi/${pbi.id}/approve`)} className="border border-[var(--signal-ok)]/60 px-2.5 py-1 font-mono text-[12px] text-[var(--signal-ok)] hover:bg-[var(--signal-ok)]/10">承認して実行</button>
            <input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="修正指示…" aria-label="修正指示" className="min-w-0 flex-1 border border-[var(--hairline)] bg-transparent px-2 py-1 font-mono text-[12px] text-[var(--ink)]" />
            <button type="button" disabled={busy || feedback.trim() === ""} onClick={() => run(`/api/pbi/${pbi.id}/revise`, { feedback })} className="border border-[var(--accent)]/60 px-2.5 py-1 font-mono text-[12px] text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40">再分解</button>
            <button type="button" disabled={busy} onClick={() => run(`/api/pbi/${pbi.id}/reject`)} className="font-mono text-[11px] text-[var(--ink-faint)] hover:text-[var(--signal-alert)]">却下</button>
          </div>
        </div>
      ) : null}

      {pbi.status === "executing" ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2">
            {pbi.subTasks.map((t) => (
              <SubTaskRow key={t.key} pbiId={pbi.id} task={t} job={t.jobId ? jobsById.get(t.jobId) : undefined} escalations={pbi.escalations} />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} onClick={() => run(`/api/pbi/${pbi.id}/${pbi.paused ? "resume" : "pause"}`)} className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-faint)] hover:text-[var(--ink)]">{pbi.paused ? "再開" : "一時停止"}</button>
            <button type="button" disabled={busy} onClick={() => run(`/api/pbi/${pbi.id}/cancel`)} className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-faint)] hover:text-[var(--signal-alert)]">中止</button>
          </div>
        </div>
      ) : null}

      {pbi.error ? <div className="font-mono text-[11px] text-[var(--signal-alert)]">{pbi.error}</div> : null}
      {error ? <div className="font-mono text-[11px] text-[var(--signal-alert)]">{error}</div> : null}
    </div>
  );
}
