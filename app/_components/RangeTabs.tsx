"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ActivityRange } from "@/lib/github/activity";

const OPTIONS: Array<{ range: ActivityRange; label: string }> = [
  { range: "today", label: "Today" },
  { range: "yesterday", label: "Yesterday" },
  { range: "7d", label: "7 days" },
  { range: "30d", label: "30 days" },
];

export function RangeTabs() {
  const params = useSearchParams();
  const current = params.get("range") ?? "today";
  const source = params.get("source");

  return (
    <nav className="flex items-center gap-1 border border-[var(--hairline-strong)] bg-[var(--background-elevated)] p-0.5">
      {OPTIONS.map((opt) => {
        const isActive = current === opt.range;
        return (
          <Link
            key={opt.range}
            href={{
              pathname: "/activity",
              query: { range: opt.range, ...(source ? { source } : {}) },
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
