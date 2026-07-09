"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";

const PERMISSION_EVENT = "cockpit:permission-changed";

type Status = "unsupported" | "default" | "granted" | "denied";

function readStatus(): Status {
  if (typeof window === "undefined") return "default";
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission as Status;
}

export function NotificationToggle() {
  const [status, setStatus] = useState<Status>("default");

  useEffect(() => {
    setStatus(readStatus());
    const onVisibility = () => setStatus(readStatus());
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const request = async () => {
    if (!("Notification" in window)) return;
    try {
      const p = await Notification.requestPermission();
      setStatus(p as Status);
      window.dispatchEvent(new Event(PERMISSION_EVENT));
    } catch {
      /* ignore */
    }
  };

  if (status === "unsupported") return null;

  if (status === "granted") {
    return (
      <span
        title="デスクトップ通知が有効です"
        className="inline-flex items-center gap-1.5 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--signal-ok)]"
      >
        <Bell size={13} />
        <span className="hidden md:inline">alerts</span>
      </span>
    );
  }

  if (status === "denied") {
    return (
      <span
        title="ブラウザ側で通知がブロックされています"
        className="inline-flex items-center gap-1.5 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-faint)]"
      >
        <BellOff size={13} />
        <span className="hidden md:inline">blocked</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={request}
      className="group inline-flex items-center gap-1.5 border border-[var(--hairline-strong)] bg-[var(--background-elevated)] px-2.5 py-1 font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-dim)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      <Bell size={13} />
      <span className="hidden md:inline">enable alerts</span>
    </button>
  );
}
