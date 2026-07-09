"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { HerdrState } from "@/lib/herdr/types";

const REFETCH_DEBOUNCE_MS = 300;

export type HerdrLoadResult =
  | { status: "loading" }
  | { status: "ok"; state: HerdrState }
  | { status: "error"; message: string };

export function useHerdrState(): { result: HerdrLoadResult; live: boolean } {
  const [result, setResult] = useState<HerdrLoadResult>({ status: "loading" });
  const [live, setLive] = useState(false);
  const hasDataRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const refetch = async () => {
      try {
        const res = await fetch("/api/panes", { cache: "no-store" });
        const body = (await res.json()) as
          | { ok: true; state: HerdrState }
          | { ok: false; error: string };
        if (cancelled) return;
        if (!body.ok) {
          // 一時的な失敗では表示中のデータを保持する
          if (!hasDataRef.current) {
            setResult({ status: "error", message: body.error });
          }
          return;
        }
        hasDataRef.current = true;
        setResult({ status: "ok", state: body.state });
      } catch (err) {
        if (cancelled || hasDataRef.current) return;
        const message =
          err instanceof Error ? err.message : "failed to load /api/panes";
        setResult({ status: "error", message });
      }
    };

    const scheduleRefetch = () => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void refetch();
      }, REFETCH_DEBOUNCE_MS);
    };

    void refetch();

    const source = new EventSource("/api/panes/events");
    source.addEventListener("open", () => {
      setLive(true);
      // 再接続中に取りこぼしたぶんを取り直す
      scheduleRefetch();
    });
    source.addEventListener("change", scheduleRefetch);
    source.addEventListener("error", () => {
      // EventSource は自動再接続する
      setLive(false);
    });

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      source.close();
    };
  }, []);

  return { result, live };
}

type HerdrContextValue = { result: HerdrLoadResult; live: boolean };

const HerdrContext = createContext<HerdrContextValue | null>(null);

// 複数コンポーネントが herdr 状態を読むとき、EventSource / fetch を
// 1 本に保つための provider。server component を children に取れる。
export function HerdrProvider({ children }: { children: ReactNode }) {
  const value = useHerdrState();
  return <HerdrContext.Provider value={value}>{children}</HerdrContext.Provider>;
}

export function useHerdrContext(): HerdrContextValue {
  const ctx = useContext(HerdrContext);
  if (!ctx) throw new Error("useHerdrContext must be used within HerdrProvider");
  return ctx;
}

export function LiveIndicator({ live }: { live: boolean }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-muted)]">
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          live ? "bg-[var(--signal-ok)]" : "bg-[var(--signal-idle)]"
        }`}
      />
      {live ? "live" : "reconnecting"}
    </div>
  );
}
