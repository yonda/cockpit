import type { ReactNode } from "react";
import { TierHeader, type TierTone } from "./Section";

// Board (home) の tier-first レイアウト用。
// 行 = tier (Needs You / Working)、行の中に Agents / Pull Requests のセルが並ぶ。
export function TierBand({
  tone,
  label,
  hint,
  children,
}: {
  tone: TierTone;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <TierHeader tone={tone} label={label} hint={hint} />
      <div className="grid grid-cols-1 gap-x-10 gap-y-10 md:grid-cols-[1.35fr_1.45fr]">
        {children}
      </div>
    </section>
  );
}

// tier セル内のソース見出し (AGENTS / PULL REQUESTS)。
// tier 見出しより一段弱く、subgroup 見出しより一段強い。
export function SourceHeader({
  title,
  count,
  right,
}: {
  title: string;
  count?: number;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5">
        <h3 className="font-mono text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
          {title}
        </h3>
        {count !== undefined ? (
          <span className="font-mono text-[12px] font-medium text-[var(--ink-muted)]">
            [{String(count).padStart(2, "0")}]
          </span>
        ) : null}
        <div className="flex-1" />
        {right}
      </div>
      <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/40 via-[var(--hairline)] to-transparent" />
    </div>
  );
}
