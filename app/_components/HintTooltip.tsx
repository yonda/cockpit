import { Info } from "lucide-react";

/**
 * cockpit テーマの hover tooltip。セクション見出しの横に置いて、
 * ⓘ に hover するとダーク背景の説明ボックスを下に表示する。
 * CSS のみで実装 (group/hint + group-hover).
 *
 * align="right" は画面右端近くに置くとき用 (ボックスを ⓘ の左方向へ展開)。
 */
export function HintTooltip({
  hint,
  align = "left",
}: {
  hint: string;
  align?: "left" | "right";
}) {
  return (
    <span className="group/hint relative inline-flex items-center">
      <Info
        size={14}
        className="cursor-help text-[var(--ink-muted)] transition hover:text-[var(--ink-dim)]"
        aria-label="section info"
      />
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-20 mt-2 w-max max-w-xl whitespace-normal border border-[var(--hairline-strong)] bg-[var(--background-elevated)] px-3 py-1.5 font-mono text-[12px] leading-relaxed text-[var(--ink-dim)] shadow-lg opacity-0 transition-opacity duration-150 group-hover/hint:opacity-100 ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        {hint}
      </span>
    </span>
  );
}
