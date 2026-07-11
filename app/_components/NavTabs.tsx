"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "./navItems";

export function NavTabs() {
  const pathname = usePathname();

  return (
    <nav className="hidden min-w-0 items-center gap-1 overflow-x-auto sm:flex">
      {NAV.map((item, index) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={String(index + 1)}
            className={`shrink-0 border-b-2 px-2 py-1 font-mono text-[13px] font-semibold uppercase tracking-[0.14em] transition ${
              active
                ? "border-[var(--accent)] text-[var(--ink)]"
                : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink-dim)]"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
