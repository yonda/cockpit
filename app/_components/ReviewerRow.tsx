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

export function ReviewerRow({ reviewers }: { reviewers: Reviewer[] }) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-muted)]">
        Reviewers
      </span>
      {reviewers.length === 0 ? (
        <span className="font-mono text-[12px] uppercase tracking-widest text-[var(--ink-faint)]">
          — none —
        </span>
      ) : (
        <div className="flex flex-wrap gap-2">
          {reviewers.map((r) => (
            <ReviewerAvatar key={r.key} reviewer={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewerAvatar({ reviewer }: { reviewer: Reviewer }) {
  const cfg = stateConfig[reviewer.state];
  const title = `${reviewer.isTeam ? "team · " : ""}@${reviewer.displayName} · ${cfg.label}`;

  return (
    <span className="relative inline-flex" title={title}>
      <span
        className={`inline-flex h-7 w-7 items-center justify-center overflow-hidden bg-[var(--background-elevated)] ${cfg.ringClass}`}
        style={{ borderRadius: reviewer.isTeam ? 3 : 999 }}
      >
        {reviewer.avatarUrl ? (
          <Image
            src={reviewer.avatarUrl}
            alt={reviewer.displayName}
            width={28}
            height={28}
            className="h-7 w-7 object-cover"
            unoptimized
          />
        ) : (
          <span className="font-mono text-[10px] text-[var(--ink-muted)]">
            {reviewer.displayName.slice(0, 2).toUpperCase()}
          </span>
        )}
      </span>
      <span
        className={`absolute -bottom-0.5 -right-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full ${cfg.dotClass} ring-1 ring-[var(--panel)]`}
      >
        <cfg.Icon size={8} />
      </span>
    </span>
  );
}
