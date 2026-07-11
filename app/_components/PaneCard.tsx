"use client";

import { useState } from "react";
import { Activity, Check, CircleDot, Loader2, Pause, HelpCircle } from "lucide-react";
import type { HerdrPane, HerdrStatus } from "@/lib/herdr/types";
import { RelativeTime } from "./RelativeTime";

const statusConfig: Record<
  HerdrStatus,
  { icon: typeof Activity; label: string; color: string; dot: string; bg: string }
> = {
  working: {
    icon: Loader2,
    label: "working",
    color: "text-[var(--signal-info)]",
    dot: "bg-[var(--signal-info)]",
    bg: "bg-[var(--signal-info)]/10 border-[var(--signal-info)]/40",
  },
  blocked: {
    icon: Pause,
    label: "blocked",
    color: "text-[var(--signal-alert)]",
    dot: "bg-[var(--signal-alert)]",
    bg: "bg-[var(--signal-alert)]/10 border-[var(--signal-alert)]/40",
  },
  done: {
    icon: Check,
    label: "done",
    color: "text-[var(--signal-ok)]",
    dot: "bg-[var(--signal-ok)]",
    bg: "bg-[var(--signal-ok)]/10 border-[var(--signal-ok)]/40",
  },
  idle: {
    icon: CircleDot,
    label: "idle",
    color: "text-[var(--signal-idle)]",
    dot: "bg-[var(--signal-idle)]",
    bg: "bg-[var(--hairline)]/40 border-[var(--hairline)]",
  },
  unknown: {
    icon: HelpCircle,
    label: "shell",
    color: "text-[var(--ink-faint)]",
    dot: "bg-[var(--ink-faint)]",
    bg: "bg-[var(--hairline)]/20 border-[var(--hairline)]",
  },
};

function StatusPill({ status }: { status: HerdrStatus }) {
  const s = statusConfig[status];
  const Icon = s.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${s.bg} ${s.color}`}
    >
      <Icon
        size={10}
        className={status === "working" ? "animate-spin" : undefined}
      />
      {s.label}
    </span>
  );
}

export function PaneCard({
  pane,
  context,
}: {
  pane: HerdrPane;
  context?: string;
}) {
  const s = statusConfig[pane.agentStatus];
  const displayCwd = pane.foregroundCwd ?? pane.cwd;
  const cwdLabel = displayCwd.split("/").slice(-2).join("/");
  const recap = pane.recap;
  const [focusPending, setFocusPending] = useState(false);

  const openInWezTerm = async () => {
    if (focusPending) return;
    setFocusPending(true);
    try {
      await fetch("/api/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: pane.workspaceId,
          tabId: pane.tabId,
        }),
      });
    } catch {
      /* ignore */
    } finally {
      setFocusPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={openInWezTerm}
      title="WezTerm でこの workspace を開く"
      className={`flex flex-col gap-2 border px-3 py-2.5 text-left transition hover:border-[var(--accent)]/60 ${
        focusPending ? "opacity-60" : ""
      } ${
        pane.focused
          ? "border-[var(--accent)]/60 bg-[var(--accent)]/5"
          : "border-[var(--hairline)] bg-[var(--background)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-muted)]">
            {context ?? pane.paneId}
          </span>
          {pane.agent ? (
            <span className={`font-mono text-[11px] font-medium ${s.color}`}>
              {pane.agent}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-[var(--ink-faint)]">
              shell
            </span>
          )}
          {pane.focused ? (
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--accent)]">
              · focused
            </span>
          ) : null}
        </div>
        <StatusPill status={pane.agentStatus} />
      </div>

      {recap?.title ? (
        <div className="text-[13px] font-semibold leading-snug text-[var(--ink)]">
          {recap.title}
        </div>
      ) : null}

      {recap?.lastPrompt ? (
        <div
          className="truncate font-mono text-[11px] text-[var(--ink-dim)]"
          title={recap.lastPrompt}
        >
          <span className="text-[var(--accent)]">› </span>
          {recap.lastPrompt}
        </div>
      ) : null}

      {recap?.lastAssistant ? (
        <div
          className="truncate font-mono text-[11px] text-[var(--ink-muted)]"
          title={recap.lastAssistant}
        >
          {recap.lastAssistant}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <span
          className="truncate font-mono text-[11px] text-[var(--ink-dim)]"
          title={displayCwd}
        >
          {cwdLabel}
        </span>
        {recap?.lastActivityAt ? (
          <RelativeTime
            iso={recap.lastActivityAt}
            variant="short"
            className="shrink-0 font-mono text-[10px] text-[var(--ink-muted)]"
          />
        ) : null}
      </div>
    </button>
  );
}
