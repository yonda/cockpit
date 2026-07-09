import type { ReactNode } from "react";
import { HintTooltip } from "./HintTooltip";

// Board の 3 カラム (Agents / Pull Requests / Today) 共通の見出し。
// カラムの正体がひと目で分かるよう、tier 見出しより一段強く飾る。
export function BoardColumnHeader({
  title,
  hint,
  hintAlign,
  right,
}: {
  title: string;
  hint: string;
  hintAlign?: "left" | "right";
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
        <h2 className="font-mono text-[16px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
          {title}
        </h2>
        <HintTooltip hint={hint} align={hintAlign} />
        <div className="flex-1" />
        {right}
      </div>
      <div className="h-px w-full bg-gradient-to-r from-[var(--accent)]/50 via-[var(--hairline-strong)] to-transparent" />
    </div>
  );
}
