"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

// GitHub GraphQL のレート制限 (5000pt/h、検索 1 回 ≈ 1pt) に対して
// 15 秒間隔 × 3 クエリ = 720/h なので余裕がある
const REFRESH_INTERVAL_MS = 15_000;
// 隠れている間もリフレッシュは続ける (新着 PR 通知の検知のため)。
// Chrome のタイマー間引きで hidden 時はどのみち 1 分粒度になる
const HIDDEN_REFRESH_INTERVAL_MS = 60_000;

export function RefreshButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lastRefreshedAt, setLastRefreshedAt] = useState(() => Date.now());
  const lastRefreshedAtRef = useRef(lastRefreshedAt);
  lastRefreshedAtRef.current = lastRefreshedAt;

  const refresh = useCallback(() => {
    startTransition(() => {
      router.refresh();
      setLastRefreshedAt(Date.now());
    });
  }, [router]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const elapsed = Date.now() - lastRefreshedAtRef.current;
      const threshold = document.hidden
        ? HIDDEN_REFRESH_INTERVAL_MS
        : REFRESH_INTERVAL_MS;
      if (elapsed >= threshold) refresh();
    }, 5_000);

    const onVisible = () => {
      if (document.hidden) return;
      const elapsed = Date.now() - lastRefreshedAtRef.current;
      if (elapsed >= REFRESH_INTERVAL_MS) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return (
    <button
      type="button"
      onClick={refresh}
      disabled={isPending}
      title={isPending ? "同期中…" : "ライブ更新中 (クリックで即時同期)"}
      className="group inline-flex items-center gap-2 border border-[var(--hairline-strong)] bg-[var(--background-elevated)] px-3 py-1.5 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          isPending ? "bg-[var(--signal-warn)]" : "bg-[var(--signal-ok)] live-dot"
        }`}
      />
      <span>sync</span>
      <span className="text-[var(--ink-muted)] transition group-hover:text-[var(--accent)]">↻</span>
    </button>
  );
}
