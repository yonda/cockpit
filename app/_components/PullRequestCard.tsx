import Image from "next/image";
import { AlertTriangle, Check, CircleDashed, MessageSquare, ThumbsUp, X } from "lucide-react";
import { Badge } from "./Badge";
import { RelativeTime } from "./RelativeTime";
import { ReviewerRow } from "./ReviewerRow";
import type { PullRequestCard as PullRequestCardType } from "@/lib/github/types";

export function PullRequestCard({ pr }: { pr: PullRequestCardType }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      className="fadeup group relative flex flex-col gap-3 border border-[var(--hairline)] bg-[var(--panel)] p-5 transition hover:border-[var(--accent)]/60 hover:bg-[var(--panel-hover)]"
    >
      <span
        className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-[var(--hairline-strong)] transition group-hover:border-[var(--accent)]"
        aria-hidden
      />

      <div className="flex items-baseline justify-between gap-2 font-mono text-[13px] font-medium">
        <span className="truncate text-[var(--ink-dim)]">
          {pr.repositoryNameWithOwner}
        </span>
        <span className="shrink-0 text-[var(--ink-muted)]">
          #{pr.number}
        </span>
      </div>

      <h3 className="text-[18px] font-semibold leading-snug text-[var(--ink)] transition group-hover:text-[var(--accent-strong)] line-clamp-2">
        {pr.title}
      </h3>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[13px] text-[var(--ink-dim)]">
        <span className="flex items-center gap-1.5">
          {pr.authorAvatarUrl ? (
            <Image
              src={pr.authorAvatarUrl}
              alt={pr.authorLogin}
              width={20}
              height={20}
              className="rounded-full"
              unoptimized
            />
          ) : null}
          <span>@{pr.authorLogin}</span>
        </span>
        <RelativeTime iso={pr.updatedAt} className="text-[var(--ink-muted)]" />
        <span className="text-[var(--signal-ok)]">+{pr.additions}</span>
        <span className="text-[var(--signal-alert)]">−{pr.deletions}</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {pr.isDraft && <Badge variant="neutral">Draft</Badge>}
        {pr.statusCheckRollup === "SUCCESS" && (
          <Badge variant="success">
            <Check size={12} /> CI
          </Badge>
        )}
        {pr.statusCheckRollup === "PENDING" && (
          <Badge variant="info">
            <CircleDashed size={12} /> CI
          </Badge>
        )}
        {(pr.statusCheckRollup === "FAILURE" || pr.statusCheckRollup === "ERROR") && (
          <Badge variant="danger">
            <X size={12} /> CI
          </Badge>
        )}
        {pr.reviewDecision === "APPROVED" && (
          <Badge variant="success">
            <ThumbsUp size={12} /> Approved
          </Badge>
        )}
        {pr.reviewDecision === "CHANGES_REQUESTED" && (
          <Badge variant="warning">changes</Badge>
        )}
        {pr.mergeable === "CONFLICTING" && (
          <Badge variant="danger">
            <AlertTriangle size={12} /> Conflict
          </Badge>
        )}
        {pr.commentCount > 0 && (
          <Badge variant="neutral">
            <MessageSquare size={12} /> {pr.commentCount}
          </Badge>
        )}
      </div>

      <div className="mt-1 border-t border-[var(--hairline)] pt-3">
        <ReviewerRow reviewers={pr.reviewers} />
      </div>
    </a>
  );
}
