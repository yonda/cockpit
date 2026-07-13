"use client";

import { useEffect, useRef } from "react";
import type { HerdrStatus } from "@/lib/herdr/types";
import { useHerdrContext } from "./useHerdrState";
import { useJobsState } from "./useJobsState";
import { playNotifySound } from "./notifySound";
import { buildSessionToJob, planPaneNotify } from "./paneNotify";

const PERMISSION_EVENT = "cockpit:permission-changed";

function isNeedsYou(
  status: HerdrStatus | undefined,
): status is "blocked" | "done" {
  return status === "blocked" || status === "done";
}


// agent が Needs You (blocked / done) に遷移した瞬間にデスクトップ通知を出す。
// データは SSE (useHerdrState) 由来なのでウィンドウが隠れていても発火する。
// pane.sessionId が HerdrExecutor ジョブに紐づくときはジョブ単位の escalation
// (「JOB #N が要判断」) に振り分け、個人ペインは従来の汎用通知にする (paneNotify.ts)。
// 通知クリックで該当ペインを WezTerm でフォーカスする (/api/focus)。
export function AgentNotifyWatcher() {
  const { result } = useHerdrContext();
  const { result: jobsResult } = useJobsState();
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
    const sessionToJob = buildSessionToJob(
      jobsResult.status === "ok" ? jobsResult.jobs : [],
    );

    let soundPlayed = false;
    for (const pane of state.panes) {
      if (!pane.agent) continue;
      const status = pane.agentStatus;
      if (!isNeedsYou(status)) continue;
      // すでに Needs You だった pane は再通知しない (blocked ↔ done の揺れも含む)
      if (isNeedsYou(prev.get(pane.paneId))) continue;

      const job = pane.sessionId
        ? sessionToJob.get(pane.sessionId)
        : undefined;
      const label = labels.get(pane.workspaceId) ?? pane.workspaceId;
      const plan = planPaneNotify(pane, job, label);
      if (!plan) continue; // ジョブ done 等はここでは鳴らさない (JobNotifyWatcher が担う)

      if (!soundPlayed) {
        soundPlayed = true;
        playNotifySound(plan.sound);
      }
      const n = new Notification(plan.title, {
        body: plan.body,
        icon: plan.icon,
        tag: plan.tag,
        requireInteraction: false,
      });
      n.onclick = () => {
        void fetch("/api/focus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(plan.focus),
        });
        n.close();
      };
    }
  }, [result, jobsResult]);

  return null;
}
