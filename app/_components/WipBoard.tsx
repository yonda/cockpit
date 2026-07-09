"use client";

import type { HerdrPane, HerdrState, HerdrStatus } from "@/lib/herdr/types";
import { PaneCard } from "./PaneCard";
import { ErrorState } from "./ErrorState";
import { EmptyRow } from "./EmptyState";
import { SectionSkeleton } from "./Skeleton";
import { useHerdrContext, LiveIndicator } from "./useHerdrState";
import { HintTooltip } from "./HintTooltip";

type WorkspaceGroup = {
  workspaceId: string;
  label: string;
  panes: HerdrPane[];
};

// Pull Requests の Now/Soon/Hold に対応する緊急度 3 階層。
// 所属は workspace 単位: workspace 内で最も緊急な pane のステータスが
// その workspace のティアを決め、pane は全部まとめてそこに表示される。
//   Needs You = blocked (返答待ち) or done (完了したが未確認) の agent がいる
//   Working   = 上記はないが実行中の agent がいる
//   Parked    = 待機中のエージェントと shell だけ
type WipTierKey = "needsYou" | "working" | "idle";

const TIER_OF: Record<HerdrStatus, WipTierKey> = {
  blocked: "needsYou",
  done: "needsYou",
  working: "working",
  idle: "idle",
  unknown: "idle",
};

const TIER_RANK: Record<WipTierKey, number> = {
  needsYou: 0,
  working: 1,
  idle: 2,
};

// 緊急な pane が上に来るよう、workspace 内の pane を並べる
const STATUS_RANK: Record<HerdrStatus, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

function paneTier(pane: HerdrPane): WipTierKey {
  // agent 無しの shell はステータスに関わらず idle 扱い
  return pane.agent ? TIER_OF[pane.agentStatus] : "idle";
}

function paneRank(pane: HerdrPane): number {
  // shell は agent の後ろに置く
  return pane.agent ? STATUS_RANK[pane.agentStatus] : 5;
}

function classifyWorkspaces(state: HerdrState): {
  needsYou: WorkspaceGroup[];
  working: WorkspaceGroup[];
  idle: WorkspaceGroup[];
} {
  const byWorkspace = new Map<string, HerdrPane[]>();
  for (const pane of state.panes) {
    const arr = byWorkspace.get(pane.workspaceId) ?? [];
    arr.push(pane);
    byWorkspace.set(pane.workspaceId, arr);
  }

  const tiers: Record<WipTierKey, WorkspaceGroup[]> = {
    needsYou: [],
    working: [],
    idle: [],
  };

  // state.workspaces は focused → number 順に整列済み
  for (const w of state.workspaces) {
    const panes = byWorkspace.get(w.workspaceId);
    if (!panes) continue;
    const tier = panes.reduce<WipTierKey>(
      (acc, p) => (TIER_RANK[paneTier(p)] < TIER_RANK[acc] ? paneTier(p) : acc),
      "idle",
    );
    tiers[tier].push({
      workspaceId: w.workspaceId,
      label: w.label,
      panes: panes
        .slice()
        .sort(
          (a, b) => paneRank(a) - paneRank(b) || a.paneId.localeCompare(b.paneId),
        ),
    });
  }

  return tiers;
}

function WorkspaceSection({ group }: { group: WorkspaceGroup }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="flex items-baseline gap-2 font-mono text-[12px] uppercase tracking-[0.1em] text-[var(--ink-dim)]">
        <span>{group.label}</span>
        <span className="normal-case tracking-normal text-[var(--ink-muted)]">
          / {String(group.panes.length).padStart(2, "0")}
        </span>
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {group.panes.map((pane) => (
          <PaneCard key={pane.paneId} pane={pane} />
        ))}
      </div>
    </div>
  );
}

function WipTier({
  label,
  hint,
  tone,
  groups,
  emptyMessage,
}: {
  label: string;
  hint: string;
  tone: { dot: string; label: string; rule: string };
  groups: WorkspaceGroup[];
  emptyMessage: string;
}) {
  // 所属が workspace 単位なので、カウントも workspace 数
  const totalCount = groups.length;
  return (
    <section className="flex flex-col gap-5">
      <header className="fadeup flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className={`inline-block h-2 w-2 rounded-full ${tone.dot}`} />
          <h2
            className={`font-mono text-[18px] font-bold uppercase tracking-[0.14em] ${tone.label}`}
          >
            {label}
          </h2>
          <span className="font-mono text-[15px] font-medium text-[var(--ink-muted)]">
            [{String(totalCount).padStart(2, "0")}]
          </span>
          <HintTooltip hint={hint} />
        </div>
        <div className={`mt-1 h-px w-full ${tone.rule}`} />
      </header>
      {totalCount === 0 ? (
        <EmptyRow message={emptyMessage} />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <WorkspaceSection key={group.workspaceId} group={group} />
          ))}
        </div>
      )}
    </section>
  );
}

export function WipBoard() {
  const { result, live } = useHerdrContext();

  if (result.status === "loading") return <SectionSkeleton />;
  if (result.status === "error") return <ErrorState message={result.message} />;

  const { needsYou, working, idle } = classifyWorkspaces(result.state);

  return (
    <div className="flex flex-col gap-4">
      <div className="self-end">
        <LiveIndicator live={live} />
      </div>
      <div className="flex flex-col gap-14">
        <WipTier
          label="Needs You"
          hint="workspaces with an agent blocked on your reply or done but not reviewed"
          tone={{
            dot: "bg-[var(--signal-alert)]",
            label: "text-[var(--signal-alert)]",
            rule: "bg-[var(--signal-alert)]/50",
          }}
          groups={needsYou}
          emptyMessage="no one needs you"
        />
        <WipTier
          label="Working"
          hint="workspaces where agents are running and nothing needs you"
          tone={{
            dot: "bg-[var(--signal-info)]",
            label: "text-[var(--signal-info)]",
            rule: "bg-[var(--signal-info)]/50",
          }}
          groups={working}
          emptyMessage="nothing running"
        />
        <WipTier
          label="Parked"
          hint="workspaces with only idle agents and plain shells"
          tone={{
            dot: "bg-[var(--ink-muted)]",
            label: "text-[var(--ink-dim)]",
            rule: "bg-[var(--hairline-strong)]",
          }}
          groups={idle}
          emptyMessage="nothing parked"
        />
      </div>
    </div>
  );
}
