"use client";

import { useEffect, useRef } from "react";
import type { HerdrPane, HerdrStatus } from "@/lib/herdr/types";
import { useHerdrContext } from "./useHerdrState";
import { playNotifySound } from "./notifySound";

const PERMISSION_EVENT = "cockpit:permission-changed";

function isNeedsYou(
  status: HerdrStatus | undefined,
): status is "blocked" | "done" {
  return status === "blocked" || status === "done";
}

function notificationBody(pane: HerdrPane): string {
  return (
    pane.recap?.title ??
    pane.recap?.lastPrompt ??
    pane.agent ??
    pane.paneId
  );
}


// agent が Needs You (blocked / done) に遷移した瞬間にデスクトップ通知を出す。
// データは SSE (useHerdrState) 由来なのでウィンドウが隠れていても発火する。
// 通知クリックで該当 workspace を WezTerm でフォーカスする (/api/focus)。
export function AgentNotifyWatcher() {
  const { result } = useHerdrContext();
  const prevRef = useRef<Map<string, HerdrStatus> | null>(null);
  const permissionRef = useRef<NotificationPermission>("default");

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    permissionRef.current = Notification.permission;

    const onPermissionChanged = () => {
      permissionRef.current = Notification.permission;
    };
    window.addEventListener(PERMISSION_EVENT, onPermissionChanged);
    return () =>
      window.removeEventListener(PERMISSION_EVENT, onPermissionChanged);
  }, []);

  useEffect(() => {
    if (result.status !== "ok") return;
    const state = result.state;

    const current = new Map<string, HerdrStatus>();
    for (const pane of state.panes) {
      if (pane.agent) current.set(pane.paneId, pane.agentStatus);
    }
    const prev = prevRef.current;
    prevRef.current = current;

    // 初回マウント: 既存の blocked/done は通知しない (リロード毎のスパム防止)
    if (!prev) return;

    if (!("Notification" in window) || permissionRef.current !== "granted") {
      return;
    }

    const labels = new Map(
      state.workspaces.map((w) => [w.workspaceId, w.label]),
    );

    let notified = false;
    for (const pane of state.panes) {
      if (!pane.agent) continue;
      const status = pane.agentStatus;
      if (!isNeedsYou(status)) continue;
      // すでに Needs You だった pane は再通知しない (blocked ↔ done の揺れも含む)
      if (isNeedsYou(prev.get(pane.paneId))) continue;

      const label = labels.get(pane.workspaceId) ?? pane.workspaceId;
      if (!notified) {
        notified = true;
        playNotifySound(status === "blocked" ? "needsYou" : "done");
      }
      const n = new Notification(
        status === "blocked"
          ? `AGENT · ${label} — waiting for you`
          : `AGENT · ${label} — done`,
        {
          body: notificationBody(pane),
          icon: status === "blocked" ? "/notify-blocked.png" : "/notify-done.png",
          tag: `cockpit:agent:${pane.paneId}:${status}`,
          requireInteraction: false,
        },
      );
      n.onclick = () => {
        void fetch("/api/focus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: pane.workspaceId,
            tabId: pane.tabId,
          }),
        });
        n.close();
      };
    }
  }, [result]);

  return null;
}
