import type { ReactNode } from "react";
import { PullRequestCard } from "./PullRequestCard";
import { EmptyState, EmptyRow } from "./EmptyState";
import { HintTooltip } from "./HintTooltip";
import type { PullRequestCard as PullRequestCardType } from "@/lib/github/types";

export type TierTone = "now" | "soon" | "hold";

const toneStyles: Record<
  TierTone,
  { marker: string; dot: string; rule: string; label: string }
> = {
  now: {
    marker: "text-[var(--signal-alert)]",
    dot: "bg-[var(--signal-alert)]",
    rule: "bg-[var(--signal-alert)]/50",
    label: "text-[var(--signal-alert)]",
  },
  // warn (amber) はカラムヘッダーのアクセント色と被るため、
  // Agents の Working と同じ info 系で「待ち行列」を表す
  soon: {
    marker: "text-[var(--signal-info)]",
    dot: "bg-[var(--signal-info)]",
    rule: "bg-[var(--signal-info)]/50",
    label: "text-[var(--signal-info)]",
  },
  hold: {
    marker: "text-[var(--ink-muted)]",
    dot: "bg-[var(--ink-muted)]",
    rule: "bg-[var(--hairline-strong)]",
    label: "text-[var(--ink-dim)]",
  },
};

export function TierHeader({
  tone,
  label,
  totalCount,
  hint,
}: {
  tone: TierTone;
  label: string;
  totalCount?: number;
  hint?: string;
}) {
  const s = toneStyles[tone];
  return (
    <header className="fadeup flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} />
        <h2
          className={`font-mono text-[18px] font-bold uppercase tracking-[0.14em] ${s.label}`}
        >
          {label}
        </h2>
        {totalCount !== undefined ? (
          <span className="font-mono text-[15px] font-medium text-[var(--ink-muted)]">
            [{String(totalCount).padStart(2, "0")}]
          </span>
        ) : null}
        {hint ? <HintTooltip hint={hint} /> : null}
      </div>
      <div className={`mt-1 h-px w-full ${s.rule}`} />
    </header>
  );
}

export type TierSectionProps = {
  tone: TierTone;
  label: string;
  totalCount: number;
  hint?: string;
  subgroups: Array<{
    title: string;
    cards: PullRequestCardType[];
  }>;
  emptyMessage: string;
  // 狭いカラム内に置くとき subgroup を横並びにせず縦に積む
  stackSubgroups?: boolean;
};

export function TierSection({
  tone,
  label,
  totalCount,
  hint,
  subgroups,
  emptyMessage,
  stackSubgroups = false,
}: TierSectionProps) {
  return (
    <section className="flex flex-col gap-5">
      <TierHeader
        tone={tone}
        label={label}
        totalCount={totalCount}
        hint={hint}
      />

      {totalCount === 0 ? (
        <EmptyRow message={emptyMessage} />
      ) : (
        <div
          className={
            stackSubgroups
              ? "flex flex-col gap-6"
              : "grid gap-x-8 gap-y-6 md:grid-cols-2"
          }
        >
          {subgroups.map((group) => (
            <SubGroup key={group.title} title={group.title} cards={group.cards} />
          ))}
        </div>
      )}
    </section>
  );
}

export function SubGroup({
  title,
  cards,
}: {
  title: string;
  cards: PullRequestCardType[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="flex items-baseline gap-2 font-mono text-[12px] uppercase tracking-[0.1em] text-[var(--ink-dim)]">
        <span>{title}</span>
        <span className="normal-case tracking-normal text-[var(--ink-muted)]">
          / {String(cards.length).padStart(2, "0")}
        </span>
      </h3>
      {cards.length === 0 ? (
        <div className="border border-dashed border-[var(--hairline)] px-3 py-4 text-center font-mono text-[12px] uppercase tracking-widest text-[var(--ink-muted)]">
          — none —
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {cards.map((pr) => (
            <PullRequestCard key={pr.id} pr={pr} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SingleGroupSection({
  tone,
  label,
  totalCount,
  hint,
  cards,
  emptyMessage,
}: {
  tone: TierTone;
  label: string;
  totalCount: number;
  hint?: string;
  cards: PullRequestCardType[];
  emptyMessage: string;
}) {
  return (
    <section className="flex flex-col gap-5">
      <TierHeader
        tone={tone}
        label={label}
        totalCount={totalCount}
        hint={hint}
      />

      {cards.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((pr) => (
            <PullRequestCard key={pr.id} pr={pr} />
          ))}
        </div>
      )}
    </section>
  );
}

export function SectionShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <h2 className="text-xl font-semibold">{title}</h2>
      </header>
      {children}
    </section>
  );
}
