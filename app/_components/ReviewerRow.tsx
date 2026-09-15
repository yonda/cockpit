import Image from "next/image";
import { Check, MessageSquare, X, Clock, EyeOff } from "lucide-react";
import type { Reviewer, ReviewerState } from "@/lib/github/types";

const stateConfig: Record<
  ReviewerState,
  {
    ringClass: string;
    dotClass: string;
    Icon: React.ComponentType<{ size?: number; className?: string }>;
    label: string;
  }
> = {
  approved: {
    ringClass: "ring-1 ring-[var(--signal-ok)]",
    dotClass: "bg-[var(--signal-ok)] text-black",
    Icon: Check,
    label: "approved",
  },
  changes_requested: {
    ringClass: "ring-1 ring-[var(--signal-alert)]",
    dotClass: "bg-[var(--signal-alert)] text-black",
    Icon: X,
    label: "changes-requested",
  },
  commented: {
    ringClass: "ring-1 ring-[var(--signal-info)]",
    dotClass: "bg-[var(--signal-info)] text-black",
    Icon: MessageSquare,
    label: "commented",
  },
  pending: {
    ringClass: "ring-1 ring-[var(--ink-muted)]",
    dotClass: "bg-[var(--ink-muted)] text-black",
    Icon: Clock,
    label: "pending",
  },
  dismissed: {
    ringClass: "ring-1 ring-[var(--ink-faint)] opacity-60",
    dotClass: "bg-[var(--ink-faint)] text-black",
    Icon: EyeOff,
    label: "dismissed",
  },
};

// PullRequestCard の 3 段目の右側に置く。カードの高さを抑えるため
// ラベルは付けず、アバターの状態ドットと title で誰がどの状態かを伝える。
export function ReviewerRow({ reviewers }: { reviewers: Reviewer[] }) {
  if (reviewers.length === 0) {
    return (
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-faint)]">
        no reviewer
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Reviewers">
      {reviewers.map((r) => (
        <ReviewerAvatar key={r.key} reviewer={r} />
      ))}
    </div>
  );
}

function ReviewerAvatar({ reviewer }: { reviewer: Reviewer }) {
  const cfg = stateConfig[reviewer.state];
  const title = `${reviewer.isTeam ? "team · " : ""}@${reviewer.displayName} · ${cfg.label}`;

  return (
    <span className="relative inline-flex" title={title}>
      <span
        className={`inline-flex h-5 w-5 items-center justify-center overflow-hidden bg-[var(--background-elevated)] ${cfg.ringClass}`}
        style={{ borderRadius: reviewer.isTeam ? 3 : 999 }}
      >
        {reviewer.avatarUrl ? (
          <Image
            src={reviewer.avatarUrl}
            alt={reviewer.displayName}
            width={20}
            height={20}
            className="h-5 w-5 object-cover"
            unoptimized
          />
        ) : (
          <span className="font-mono text-[8px] text-[var(--ink-muted)]">
            {reviewer.displayName.slice(0, 2).toUpperCase()}
          </span>
        )}
      </span>
      <span
        className={`absolute -bottom-0.5 -right-0.5 inline-flex h-2.5 w-2.5 items-center justify-center rounded-full ${cfg.dotClass} ring-1 ring-[var(--panel)]`}
      >
        <cfg.Icon size={7} />
      </span>
    </span>
  );
}
