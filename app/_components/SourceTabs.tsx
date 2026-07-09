"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

export type ActivitySource = "all" | "github" | "claude";

const OPTIONS: Array<{ source: ActivitySource; label: string }> = [
  { source: "all", label: "All" },
  { source: "github", label: "GitHub" },
  { source: "claude", label: "Claude Code" },
];

export function SourceTabs() {
  const params = useSearchParams();
  const current = params.get("source") ?? "all";
  const range = params.get("range");

  return (
    <nav className="flex items-center gap-1 border border-[var(--hairline-strong)] bg-[var(--background-elevated)] p-0.5">
      {OPTIONS.map((opt) => {
        const isActive = current === opt.source;
        return (
          <Link
            key={opt.source}
            href={{
              pathname: "/activity",
              query: { source: opt.source, ...(range ? { range } : {}) },
            }}
            replace
            scroll={false}
            className={`px-3 py-1 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] transition ${
              isActive
                ? "bg-[var(--accent)] text-[#1a1300]"
                : "text-[var(--ink-dim)] hover:text-[var(--accent)]"
            }`}
          >
            {opt.label}
          </Link>
        );
      })}
    </nav>
  );
}
