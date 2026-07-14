// app/_components/PbiBoard.tsx
"use client";

import { useState } from "react";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { LiveIndicator } from "./useHerdrState";
import { PbiCard } from "./PbiCard";
import { usePbiState } from "./usePbiState";
import { isPbiOpen } from "@/lib/pbi/types";

type Segment = "active" | "done" | "all";

export function PbiBoard() {
  const { result, jobsById, live } = usePbiState();
  const [segment, setSegment] = useState<Segment>("active");

  const pbis = result.status === "ok" ? result.pbis : [];
  const activePbis = pbis.filter((p) => isPbiOpen(p.status));
  const donePbis = pbis.filter((p) => !isPbiOpen(p.status));
  const visiblePbis = segment === "all" ? pbis : segment === "active" ? activePbis : donePbis;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">PBIs</h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center border border-[var(--hairline)]">
            {(
              [
                { key: "active", label: `active ${activePbis.length}` },
                { key: "done", label: `done ${donePbis.length}` },
                { key: "all", label: "all" },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setSegment(key)}
                className={`px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition ${segment === key ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "text-[var(--ink-faint)] hover:text-[var(--ink-muted)]"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <LiveIndicator live={live} />
        </div>
      </div>
      {result.status === "loading" ? (
        <EmptyState message="loading…" />
      ) : result.status === "error" ? (
        <ErrorState title="runner unreachable" message={`${result.message} — bin/service runner-status で確認`} />
      ) : pbis.length === 0 ? (
        <EmptyState message="まだ PBI はありません。Launch タブで候補 issue を launch してください" />
      ) : visiblePbis.length === 0 ? (
        <EmptyState message={segment === "active" ? "アクティブな PBI はありません" : "終了した PBI はありません"} />
      ) : (
        <div className="flex flex-col gap-3">
          {visiblePbis.map((pbi) => (
            <PbiCard key={pbi.id} pbi={pbi} jobsById={jobsById} />
          ))}
        </div>
      )}
    </section>
  );
}
