import Link from "next/link";
import Image from "next/image";
import { RefreshButton } from "./RefreshButton";
import { NotificationToggle } from "./NotificationToggle";
import { ThemeToggle } from "./ThemeToggle";
import { NavTabs } from "./NavTabs";

// layout.tsx から一度だけ描画される (タブ遷移では再描画されない)。
// アクティブタブの判定は NavTabs (client, usePathname) が担う。
export function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--hairline)] bg-[var(--background)]/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 pt-5 pb-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-4 md:gap-6">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-3 text-[30px] font-extrabold leading-none tracking-tight text-[var(--ink)]"
            style={{ fontFamily: "var(--font-mono), ui-monospace, monospace" }}
          >
            <Image
              src="/icon.png"
              alt=""
              width={36}
              height={36}
              className="h-9 w-9"
              priority
            />
            <span>cockpit</span>
          </Link>

          <NavTabs />
        </div>

        <div className="flex shrink-0 items-center gap-3 md:gap-5">
          <ThemeToggle />
          <NotificationToggle />
          <RefreshButton />
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-4 sm:px-8">
        <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent)]/40 to-transparent" />
      </div>
    </header>
  );
}
