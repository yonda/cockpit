"use client";

import type { HerdrPane, HerdrState } from "@/lib/herdr/types";
import { PaneCard } from "./PaneCard";
import { ErrorState } from "./ErrorState";
import { EmptyRow } from "./EmptyState";
import { SectionSkeleton } from "./Skeleton";
import { useHerdrContext, LiveIndicator } from "./useHerdrState";
import { SourceHeader } from "./BoardTier";

type LabeledPane = { pane: HerdrPane; workspaceLabel: string };

function attentionPanes(state: HerdrState): {
  needsYou: LabeledPane[];
  working: LabeledPane[];
} {
  const labels = new Map(
    state.workspaces.map((w) => [w.workspaceId, w.label]),
  );
  const withLabel = (pane: HerdrPane) => ({
    pane,
    workspaceLabel: labels.get(pane.workspaceId) ?? pane.workspaceId,
  });
  const agents = state.panes.filter((p) => p.agent);
  return {
    // WIP タブと同じ定義: blocked (返答待ち) を先頭に、done (完了未確認) を続ける
    needsYou: [
      ...agents.filter((p) => p.agentStatus === "blocked"),
      ...agents.filter((p) => p.agentStatus === "done"),
    ].map(withLabel),
    working: agents.filter((p) => p.agentStatus === "working").map(withLabel),
  };
}

const TIER_META = {
  needsYou: { emptyMessage: "no one needs you" },
  working: { emptyMessage: "nothing running" },
} as const;

// tier-first Board の Agents セル。herdr 状態は HerdrProvider から共有される。
export function AgentsTierCell({ tier }: { tier: "needsYou" | "working" }) {
  const { result, live } = useHerdrContext();
  const panes =
    result.status === "ok" ? attentionPanes(result.state)[tier] : null;

  return (
    <section className="flex flex-col gap-4">
      <SourceHeader
        title="Agents"
        count={panes?.length}
        right={<LiveIndicator live={live} />}
      />

      {result.status === "loading" ? (
        <SectionSkeleton />
      ) : result.status === "error" ? (
        <ErrorState message={result.message} />
      ) : panes && panes.length === 0 ? (
        <EmptyRow message={TIER_META[tier].emptyMessage} />
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {panes?.map(({ pane, workspaceLabel }) => (
            <PaneCard key={pane.paneId} pane={pane} context={workspaceLabel} />
          ))}
        </div>
      )}
    </section>
  );
}
