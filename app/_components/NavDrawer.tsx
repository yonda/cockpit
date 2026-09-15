"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { NAV } from "./navItems";

// ヘッダ左端のハンバーガーボタンと、そこから開く左ドロワー。
// 閉じている間もボタンに現在のボード名を出し、どこにいるかを見失わないようにする。
// 数字キーでの遷移は KeyboardNav が担い、ここではヒントとして番号を並べるだけ。
export function NavDrawer() {
  const pathname = usePathname();
  // 「開いた時点の pathname」を持ち、現在の pathname と一致する間だけ開いているとみなす。
  // Link クリックでも数字キーでも、遷移すれば effect なしで自然に閉じる。
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const setOpen = (next: boolean) => setOpenedAt(next ? pathname : null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);

  const current = NAV.find((item) => item.href === pathname);

  useEffect(() => {
    if (!open) return;
    firstLinkRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpenedAt(null);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="ボードを切り替える"
        aria-expanded={open}
        aria-controls="nav-drawer"
        className="inline-flex shrink-0 items-center gap-2 border border-[var(--hairline-strong)] bg-[var(--background-elevated)] px-2.5 py-1.5 font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-dim)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        <Menu size={15} aria-hidden />
        {current && <span className="text-[var(--ink)]">{current.label}</span>}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <nav
            id="nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="ボード一覧"
            className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-[var(--hairline-strong)] bg-[var(--background-elevated)] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--hairline)] px-4 py-3">
              <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                Boards
              </span>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                aria-label="閉じる"
                className="inline-flex items-center border border-transparent p-1 text-[var(--ink-muted)] transition hover:border-[var(--hairline-strong)] hover:text-[var(--ink)]"
              >
                <X size={14} aria-hidden />
              </button>
            </div>

            <ul className="flex flex-col py-2">
              {NAV.map((item, index) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      ref={index === 0 ? firstLinkRef : undefined}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center justify-between gap-3 border-l-2 px-4 py-2.5 font-mono text-[13px] font-semibold uppercase tracking-[0.14em] transition ${
                        active
                          ? "border-[var(--accent)] bg-[var(--panel)] text-[var(--ink)]"
                          : "border-transparent text-[var(--ink-muted)] hover:bg-[var(--panel)] hover:text-[var(--ink-dim)]"
                      }`}
                    >
                      <span>{item.label}</span>
                      <kbd className="border border-[var(--hairline)] px-1.5 py-px font-mono text-[10px] text-[var(--ink-faint)]">
                        {index + 1}
                      </kbd>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </>
      )}
    </>
  );
}
