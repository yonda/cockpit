import type { ReactNode } from "react";

type BadgeVariant = "neutral" | "success" | "warning" | "danger" | "info";

const variantClasses: Record<BadgeVariant, string> = {
  neutral: "border-[var(--hairline-strong)] text-[var(--ink-dim)]",
  success: "border-[var(--signal-ok)]/60 text-[var(--signal-ok)]",
  warning: "border-[var(--signal-warn)]/70 text-[var(--signal-warn)]",
  danger: "border-[var(--signal-alert)]/70 text-[var(--signal-alert)]",
  info: "border-[var(--signal-info)]/70 text-[var(--signal-info)]",
};

export function Badge({
  variant = "neutral",
  children,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[11.5px] font-semibold uppercase tracking-[0.08em] ${variantClasses[variant]}`}
    >
      {children}
    </span>
  );
}
