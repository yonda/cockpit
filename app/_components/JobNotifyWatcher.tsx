"use client";

import { useEffect, useRef } from "react";
import type { Job, JobStatus } from "@/lib/jobs/types";
import { playNotifySound } from "./notifySound";
import { useJobsState } from "./useJobsState";

const NOTIFY_STATUSES = new Set<JobStatus>(["waiting_input", "done", "failed"]);

function title(job: Job): string {
  switch (job.status) {
    case "waiting_input":
      return `JOB · #${job.issueNumber} — needs your approval`;
    case "done":
      return `JOB · #${job.issueNumber} — PR ready`;
    default:
      return `JOB · #${job.issueNumber} — failed`;
  }
}

// launch ジョブが waiting_input / done / failed に遷移した瞬間に通知する。
// layout に常駐するので、どのページを見ていても届く。
export function JobNotifyWatcher() {
  const { result } = useJobsState();
  const prevRef = useRef<Map<string, JobStatus> | null>(null);

  useEffect(() => {
    if (result.status !== "ok") return;

    const current = new Map(result.jobs.map((j) => [j.id, j.status]));
    const prev = prevRef.current;
    prevRef.current = current;

    // 初回マウント: 既存状態は通知しない (リロード毎のスパム防止)
    if (!prev) return;
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    for (const job of result.jobs) {
      if (!NOTIFY_STATUSES.has(job.status)) continue;
      if (prev.get(job.id) === job.status) continue;

      playNotifySound(job.status === "done" ? "done" : "needsYou");
      const n = new Notification(title(job), {
        body: job.pendingInput?.toolName ?? job.error ?? job.issueTitle,
        icon: job.status === "done" ? "/notify-done.png" : "/notify-blocked.png",
        tag: `cockpit:job:${job.id}:${job.status}`,
        requireInteraction: false,
      });
      n.onclick = () => {
        window.focus();
        window.location.href = "/launch";
        n.close();
      };
    }
  }, [result]);

  return null;
}
