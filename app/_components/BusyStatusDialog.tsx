"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ViewerStatus } from "@/lib/github/fetchers";

const STORAGE_KEY = "cockpit:busy:snoozeUntil";
const SNOOZE_MS = 30 * 60_000;
// 解除成功後、refresh で busy でなくなった props が届くまでダイアログを隠す猶予
const CLEARED_GRACE_MS = 60_000;

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function notify() {
  for (const listener of listeners) listener();
}

function loadSnoozeUntil(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function saveSnoozeUntil(until: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(until));
  } catch {
    /* quota / private mode — ignore */
  }
  notify();
}

function isSnoozedNow(): boolean {
  return Date.now() < loadSnoozeUntil();
}

export function BusyStatusDialog({ status }: { status: ViewerStatus }) {
  const router = useRouter();
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SSR では常にスヌーズ扱い (= 非表示) にして hydration ミスマッチを避ける
  const snoozed = useSyncExternalStore(subscribe, isSnoozedNow, () => true);

  // スヌーズ明けはポーリングを待たずタイマーで拾う
  useEffect(() => {
    if (!snoozed) return;
    const remaining = loadSnoozeUntil() - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(notify, remaining);
    return () => window.clearTimeout(timer);
  }, [snoozed]);

  const busy = status?.indicatesLimitedAvailability === true;
  if (!busy || snoozed) return null;

  const expiresLabel = status?.expiresAt
    ? new Date(status.expiresAt).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const snooze = () => {
    setError(null);
    saveSnoozeUntil(Date.now() + SNOOZE_MS);
  };

  const clearStatus = async () => {
    setClearing(true);
    setError(null);
    try {
      const res = await fetch("/api/github-status/clear", { method: "POST" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      saveSnoozeUntil(Date.now() + CLEARED_GRACE_MS);
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setClearing(false);
    }
  };

  const scopeHint = error != null && /scope/i.test(error);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="GitHub ステータスが busy のままです"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-sm border border-[var(--signal-warn)]/70 bg-[var(--background-elevated)] p-5 shadow-2xl">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--signal-warn)]">
          GitHub status: busy
        </p>
        <p className="mt-3 text-[14px] font-semibold text-[var(--ink)]">
          {status?.message || "busy ステータスが設定されたままです"}
        </p>
        <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
          {expiresLabel
            ? `${expiresLabel} に自動解除されます`
            : "自動解除の期限は設定されていません"}
        </p>
        {error != null && (
          <div className="mt-3 border border-[var(--signal-alert)]/60 p-2 text-[12px] text-[var(--signal-alert)]">
            <p className="break-all">{error}</p>
            {scopeHint && (
              <p className="mt-1 text-[var(--ink-muted)]">
                トークンに user スコープが必要です:{" "}
                <code className="font-mono">
                  gh auth refresh -h github.com -s user
                </code>{" "}
                のあと <code className="font-mono">bin/service restart</code>
              </p>
            )}
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={clearStatus}
            disabled={clearing}
            className="flex-1 border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--accent)] transition hover:bg-[var(--accent)]/20 disabled:opacity-40"
          >
            {clearing ? "解除中…" : "busy を解除"}
          </button>
          <button
            type="button"
            onClick={snooze}
            disabled={clearing}
            className="border border-[var(--hairline-strong)] px-3 py-2 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)] transition hover:text-[var(--ink)] disabled:opacity-40"
          >
            あとで (30分)
          </button>
        </div>
      </div>
    </div>
  );
}
