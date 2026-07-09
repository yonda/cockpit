"use client";

import { useEffect, useRef } from "react";
import { playNotifySound } from "./notifySound";

const STORAGE_KEY = "cockpit:now:seen";
const PERMISSION_EVENT = "cockpit:permission-changed";

export type NowNotifyCard = {
  id: string;
  title: string;
  repo: string;
  url: string;
  bucket: "mine" | "review";
};

function loadSeen(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveSeen(set: Set<string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* quota / private mode — ignore */
  }
}

export function NowWatcher({ cards }: { cards: NowNotifyCard[] }) {
  const initializedRef = useRef(false);
  const permissionRef = useRef<NotificationPermission>("default");

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    permissionRef.current = Notification.permission;

    const onPermissionChanged = () => {
      permissionRef.current = Notification.permission;
    };
    window.addEventListener(PERMISSION_EVENT, onPermissionChanged);
    return () => window.removeEventListener(PERMISSION_EVENT, onPermissionChanged);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const seen = loadSeen();
    const currentIds = new Set(cards.map((c) => c.id));

    // 初回マウント: 現状の NOW を「既知」としてマーク、通知は出さない
    if (!initializedRef.current) {
      initializedRef.current = true;
      // 現存する NOW を seen に追加（PWA 再起動でも既存分は通知しない）
      for (const id of currentIds) seen.add(id);
      saveSeen(seen);
      return;
    }

    const fresh = cards.filter((c) => !seen.has(c.id));
    if (fresh.length === 0) return;

    const canNotify =
      "Notification" in window && permissionRef.current === "granted";

    if (canNotify) {
      // PR の Needs You 入りはアクション待ち = agent の blocked と同じ Ping
      playNotifySound("needsYou");
      for (const card of fresh) {
        const n = new Notification(
          `${card.bucket === "review" ? "REVIEW" : "PR"} · ${card.repo}`,
          {
            body: card.title,
            icon: "/notify-blocked.png",
            tag: `cockpit:${card.id}`,
            requireInteraction: false,
          },
        );
        n.onclick = () => {
          window.open(card.url, "_blank", "noopener,noreferrer");
          n.close();
        };
      }
    }

    for (const c of fresh) seen.add(c.id);
    // 現状 NOW から消えた ID は seen からも取り除いて肥大化を防ぐ
    for (const id of Array.from(seen)) {
      if (!currentIds.has(id)) seen.delete(id);
    }
    saveSeen(seen);
  }, [cards]);

  return null;
}
