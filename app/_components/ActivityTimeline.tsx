import Image from "next/image";
import { format } from "date-fns";
import {
  Check,
  MessageSquare,
  X,
  MessageCircleMore,
  GitPullRequest,
  GitMerge,
  CircleSlash,
  Bot,
} from "lucide-react";
import type { ActivityEvent } from "@/lib/github/activity";
import type { ClaudeActivityEvent } from "@/lib/claude/activity";
import { groupByDay } from "@/lib/format/dayGroup";
import { EmptyState } from "./EmptyState";

export type FeedEvent = ActivityEvent | ClaudeActivityEvent;

const kindConfig = {
  opened: {
    icon: GitPullRequest,
    dot: "bg-[var(--accent)]",
    label: "opened",
    color: "text-[var(--accent)]",
  },
  merged: {
    icon: GitMerge,
    dot: "bg-[var(--signal-ok)]",
    label: "merged",
    color: "text-[var(--signal-ok)]",
  },
  closed: {
    icon: CircleSlash,
    dot: "bg-[var(--ink-muted)]",
    label: "closed",
    color: "text-[var(--ink-muted)]",
  },
  approved: {
    icon: Check,
    dot: "bg-[var(--signal-ok)]",
    label: "approved",
    color: "text-[var(--signal-ok)]",
  },
  changes_requested: {
    icon: X,
    dot: "bg-[var(--signal-alert)]",
    label: "changes-requested",
    color: "text-[var(--signal-alert)]",
  },
  commented_review: {
    icon: MessageSquare,
    dot: "bg-[var(--signal-info)]",
    label: "review comment",
    color: "text-[var(--signal-info)]",
  },
  dismissed: {
    icon: X,
    dot: "bg-[var(--ink-muted)]",
    label: "dismissed",
    color: "text-[var(--ink-muted)]",
  },
  comment: {
    icon: MessageCircleMore,
    dot: "bg-[var(--ink-dim)]",
    label: "commented",
    color: "text-[var(--ink-dim)]",
  },
} as const;

function pickConfig(event: ActivityEvent) {
  switch (event.kind) {
    case "opened":
      return kindConfig.opened;
    case "merged":
      return kindConfig.merged;
    case "closed":
      return kindConfig.closed;
    case "comment":
      return kindConfig.comment;
    case "review":
      switch (event.reviewState) {
        case "APPROVED":
          return kindConfig.approved;
        case "CHANGES_REQUESTED":
          return kindConfig.changes_requested;
        case "COMMENTED":
          return kindConfig.commented_review;
        case "DISMISSED":
          return kindConfig.dismissed;
        default:
          return kindConfig.comment;
      }
  }
}

function snippet(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const oneLine = trimmed.replace(/\s+/g, " ");
  return oneLine.length > 200 ? oneLine.slice(0, 200) + "…" : oneLine;
}

export function ActivityTimeline({ events }: { events: FeedEvent[] }) {
  if (events.length === 0) {
    return <EmptyState message="この期間にはアクティビティなし" />;
  }
  const groups = groupByDay(events);

  return (
    <div className="flex flex-col gap-10">
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-4">
          <header className="flex items-center gap-3">
            <h2 className="font-mono text-[14px] font-bold uppercase tracking-[0.16em] text-[var(--ink-dim)]">
              {group.label}
            </h2>
            <span className="font-mono text-[13px] text-[var(--ink-muted)]">
              [{String(group.items.length).padStart(2, "0")}]
            </span>
            <div className="h-px flex-1 bg-[var(--hairline)]" />
          </header>
          <ul className="flex flex-col gap-2">
            {group.items.map((event) =>
              event.kind === "prompt" ? (
                <PromptRow key={event.key} event={event} />
              ) : (
                <ActivityRow key={event.key} event={event} />
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PromptRow({ event }: { event: ClaudeActivityEvent }) {
  const time = format(new Date(event.at), "HH:mm");
  return (
    <li>
      <div className="fadeup grid grid-cols-[56px_20px_1fr] items-start gap-3 border border-transparent bg-transparent p-3 transition hover:border-[var(--hairline)] hover:bg-[var(--panel)]">
        <span className="pt-0.5 font-mono text-[13px] text-[var(--ink-muted)]">
          {time}
        </span>

        <span className="pt-1 flex justify-center">
          <span className="inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
        </span>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[14px]">
            <span className="font-medium text-[var(--ink)]">you</span>
            <span className="inline-flex items-center gap-1 font-mono text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[var(--accent)]">
              <Bot size={12} /> prompted
            </span>
            <span className="font-mono text-[13px] text-[var(--ink-muted)]">on</span>
            <span className="flex items-center gap-1.5 font-mono text-[13px] text-[var(--ink-dim)]">
              <span>{event.project}</span>
              {event.branch ? (
                <span className="text-[var(--ink-muted)]">({event.branch})</span>
              ) : null}
            </span>
          </div>

          {event.sessionTitle ? (
            <div className="text-[15px] text-[var(--ink-dim)] line-clamp-1">
              {event.sessionTitle}
            </div>
          ) : null}

          <div className="border-l-2 border-[var(--accent)]/40 pl-3 font-mono text-[13px] leading-relaxed text-[var(--ink-muted)] line-clamp-2">
            {event.body}
          </div>
        </div>
      </div>
    </li>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const cfg = pickConfig(event);
  const time = format(new Date(event.at), "HH:mm");
  const Icon = cfg.icon;
  const body = snippet(event.body);
  const inMyPr = event.pr.sources.includes("authored");

  return (
    <li>
      <a
        href={event.url}
        target="_blank"
        rel="noopener noreferrer"
        className="fadeup group grid grid-cols-[56px_20px_1fr] items-start gap-3 border border-transparent bg-transparent p-3 transition hover:border-[var(--hairline)] hover:bg-[var(--panel)]"
      >
        <span className="pt-0.5 font-mono text-[13px] text-[var(--ink-muted)]">{time}</span>

        <span className="pt-1 flex justify-center">
          <span className={`inline-flex h-2 w-2 rounded-full ${cfg.dot}`} />
        </span>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[14px]">
            <span className="inline-flex items-center gap-1.5">
              {event.actorAvatarUrl ? (
                <Image
                  src={event.actorAvatarUrl}
                  alt={event.actorLogin}
                  width={20}
                  height={20}
                  className="rounded-full"
                  unoptimized
                />
              ) : null}
              <span className="font-medium text-[var(--ink)]">
                {event.isSelf ? "you" : `@${event.actorLogin}`}
              </span>
            </span>

            <span
              className={`inline-flex items-center gap-1 font-mono text-[11.5px] font-semibold uppercase tracking-[0.08em] ${cfg.color}`}
            >
              <Icon size={12} /> {cfg.label}
            </span>

            <span className="font-mono text-[13px] text-[var(--ink-muted)]">
              {event.kind === "opened" || event.kind === "merged" || event.kind === "closed"
                ? "—"
                : "on"}
            </span>

            <span className="flex items-center gap-1.5 font-mono text-[13px] text-[var(--ink-dim)]">
              <span>{event.pr.repo}</span>
              <span className="text-[var(--ink-muted)]">#{event.pr.number}</span>
              {inMyPr ? (
                <span className="border border-[var(--accent)]/60 px-1 text-[11px] uppercase tracking-widest text-[var(--accent)]">
                  yours
                </span>
              ) : null}
            </span>
          </div>

          <div className="text-[15px] text-[var(--ink-dim)] group-hover:text-[var(--ink)] line-clamp-2">
            {event.pr.title}
          </div>

          {body ? (
            <div className="border-l-2 border-[var(--hairline-strong)] pl-3 font-mono text-[13px] leading-relaxed text-[var(--ink-muted)] line-clamp-2">
              {body}
            </div>
          ) : null}
        </div>
      </a>
    </li>
  );
}
