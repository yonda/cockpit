import Image from "next/image";
import { AlertTriangle, Check, CircleDashed, MessageSquare, ThumbsUp, X } from "lucide-react";
import { Badge } from "./Badge";
import { RelativeTime } from "./RelativeTime";
import { ReviewerRow } from "./ReviewerRow";
import type { PullRequestCard as PullRequestCardType } from "@/lib/github/types";

// 1 画面に入る件数を優先し 3 段に収める:
//   1. repo / #番号 と状態バッジ
//   2. タイトル
//   3. 作者 / 更新時刻 / 差分 とレビュアー
// 表示する項目は減らさず、段の統合と余白の削減だけで高さを下げる。
export function PullRequestCard({ pr }: { pr: PullRequestCardType }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      className="fadeup group relative flex flex-col gap-1.5 border border-[var(--hairline)] bg-[var(--panel)] px-3.5 py-2.5 transition hover:border-[var(--accent)]/60 hover:bg-[var(--panel-hover)]"
    >
      <span
        className="pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-[var(--hairline-strong)] transition group-hover:border-[var(--accent)]"
        aria-hidden
      />

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-2 font-mono text-[12px] font-medium">
          <span className="truncate text-[var(--ink-dim)]">
            {pr.repositoryNameWithOwner}
          </span>
          <span className="shrink-0 text-[var(--ink-muted)]">
            #{pr.number}
          </span>
        </div>

        <div className="flex flex-wrap gap-1">
          {pr.isDraft && <Badge variant="neutral">Draft</Badge>}
          {pr.statusCheckRollup === "SUCCESS" && (
            <Badge variant="success">
              <Check size={11} /> CI
            </Badge>
          )}
          {pr.statusCheckRollup === "PENDING" && (
            <Badge variant="info">
              <CircleDashed size={11} /> CI
            </Badge>
          )}
          {(pr.statusCheckRollup === "FAILURE" || pr.statusCheckRollup === "ERROR") && (
            <Badge variant="danger">
              <X size={11} /> CI
            </Badge>
          )}
          {pr.reviewDecision === "APPROVED" && (
            <Badge variant="success">
              <ThumbsUp size={11} /> Approved
            </Badge>
          )}
          {pr.reviewDecision === "CHANGES_REQUESTED" && (
            <Badge variant="warning">changes</Badge>
          )}
          {pr.mergeable === "CONFLICTING" && (
            <Badge variant="danger">
              <AlertTriangle size={11} /> Conflict
            </Badge>
          )}
          {pr.commentCount > 0 && (
            <Badge variant="neutral">
              <MessageSquare size={11} /> {pr.commentCount}
            </Badge>
          )}
        </div>
      </div>

      <h3 className="text-[15px] font-semibold leading-snug text-[var(--ink)] transition group-hover:text-[var(--accent-strong)] line-clamp-2">
        {pr.title}
      </h3>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[12px] text-[var(--ink-dim)]">
          <span className="flex items-center gap-1">
            {pr.authorAvatarUrl ? (
              <Image
                src={pr.authorAvatarUrl}
                alt={pr.authorLogin}
                width={16}
                height={16}
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

        <ReviewerRow reviewers={pr.reviewers} />
      </div>
    </a>
  );
}
