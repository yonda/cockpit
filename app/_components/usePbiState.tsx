"use client";

import { useEffect, useRef, useState } from "react";
import type { Job } from "@/lib/jobs/types";
import type { PbiJob } from "@/lib/pbi/types";

const REFETCH_DEBOUNCE_MS = 300;

export type PbiLoadResult =
  | { status: "loading" }
  | { status: "ok"; pbis: PbiJob[] }
  | { status: "error"; message: string };

export function usePbiState(): {
  result: PbiLoadResult;
  jobsById: Map<string, Job>;
  live: boolean;
} {
  const [result, setResult] = useState<PbiLoadResult>({ status: "loading" });
  const [jobsById, setJobsById] = useState<Map<string, Job>>(new Map());
  const [live, setLive] = useState(false);
  const hasDataRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const refetch = async () => {
      try {
        const [pbiRes, jobRes] = await Promise.all([
          fetch("/api/pbi", { cache: "no-store" }),
          fetch("/api/jobs", { cache: "no-store" }),
        ]);
        const pbiBody = (await pbiRes.json()) as
          | { ok: true; pbis: PbiJob[] }
          | { ok: false; error: string };
        const jobBody = (await jobRes.json()) as
          | { ok: true; jobs: Job[] }
          | { ok: false; error: string };
        if (cancelled) return;
        if (!pbiBody.ok) {
          if (!hasDataRef.current) setResult({ status: "error", message: pbiBody.error });
          return;
        }
        hasDataRef.current = true;
        setResult({ status: "ok", pbis: pbiBody.pbis });
        if (jobBody.ok) {
          setJobsById(new Map(jobBody.jobs.map((j) => [j.id, j])));
        }
      } catch (err) {
        if (cancelled || hasDataRef.current) return;
        setResult({
          status: "error",
          message: err instanceof Error ? err.message : "failed to load /api/pbi",
        });
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

  return { result, jobsById, live };
}
