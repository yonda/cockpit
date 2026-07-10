"use client";

import { useEffect, useRef, useState } from "react";
import type { Job } from "@/lib/jobs/types";

const REFETCH_DEBOUNCE_MS = 300;

export type JobsLoadResult =
  | { status: "loading" }
  | { status: "ok"; jobs: Job[] }
  | { status: "error"; message: string };

export function useJobsState(): { result: JobsLoadResult; live: boolean } {
  const [result, setResult] = useState<JobsLoadResult>({ status: "loading" });
  const [live, setLive] = useState(false);
  const hasDataRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const refetch = async () => {
      try {
        const res = await fetch("/api/jobs", { cache: "no-store" });
        const body = (await res.json()) as
          | { ok: true; jobs: Job[] }
          | { ok: false; error: string };
        if (cancelled) return;
        if (!body.ok) {
          if (!hasDataRef.current) {
            setResult({ status: "error", message: body.error });
          }
          return;
        }
        hasDataRef.current = true;
        setResult({ status: "ok", jobs: body.jobs });
      } catch (err) {
        if (cancelled || hasDataRef.current) return;
        const message =
          err instanceof Error ? err.message : "failed to load /api/jobs";
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

    const source = new EventSource("/api/jobs/events");
    source.addEventListener("open", () => {
      setLive(true);
      scheduleRefetch();
    });
    source.addEventListener("change", scheduleRefetch);
    source.addEventListener("error", () => setLive(false));

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      source.close();
    };
  }, []);

  return { result, live };
}
