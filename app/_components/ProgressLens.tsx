import { cache, Fragment } from "react";
import { AlertOctagon } from "lucide-react";
import { listProgressFiles } from "@/lib/runs/list";
import { joinProgressFilesWithGithub } from "@/lib/github/runJoin";
import type { JoinedNode, JoinedProgressFile } from "@/lib/github/runJoin";
import type { ProgressEscalation } from "@/lib/runs/progress";
import { BOX_H, BOX_W, layoutRunGraph } from "@/lib/runs/layout";
import { STAGES, deriveCondition, deriveStage, stageLabel } from "@/lib/runs/nodeStage";
import type { NodeCondition, NodeStage } from "@/lib/runs/nodeStage";
import { EmptyState } from "./EmptyState";

// issue-driver の進捗ファイル(ライブ状態) × GitHub(確定状態) の join レンズ。
// 平常時は端末を覗かずに「どの issue がどう分解され、今どうなっているか」を見るための画面。
const fetchRuns = cache(async () => {
  const { files, skipped } = listProgressFiles();
  const joined = await joinProgressFilesWithGithub(files);
  return { joined, skipped };
});

function hasEscalation(run: JoinedProgressFile): boolean {
  return run.escalation !== null || run.nodes.some((n) => n.escalation !== null);
}

export async function ProgressLens() {
  const { joined, skipped } = await fetchRuns();

  if (joined.length === 0) {
    return <EmptyState message="no active issue-driver runs" />;
  }

  // done かつ escalation なしの run だけを折りたたみ対象にする。
  // エスカレーション中の run は phase が "done" であっても進行中側で目立たせ続ける。
  const inProgress = joined.filter((run) => run.phase !== "done" || hasEscalation(run));
  const done = joined.filter((run) => run.phase === "done" && !hasEscalation(run));

  // escalated な run を最上位に(= WezTerm を覗くべき理由がある run から見える)
  const sorted = [...inProgress].sort((a, b) => Number(hasEscalation(b)) - Number(hasEscalation(a)));

  return (
    <div className="flex flex-col gap-6">
      {skipped.length > 0 ? (
        <p className="border border-dashed border-[var(--hairline)] px-4 py-2 font-mono text-[11px] text-[var(--ink-muted)]">
          {skipped.length} 件の run ファイルが破損/読取失敗のためスキップされました
        </p>
      ) : null}
      {sorted.map((run) => (
        <RunCard key={`${run.repo}#${run.issueNumber}`} run={run} />
      ))}
      {done.length > 0 ? <DoneSection runs={done} /> : null}
    </div>
  );
}

// 完了(done)の run をまとめる折りたたみセクション。ネイティブ <details> でトグルを実装し、
// クライアント JS なしで開閉できるようにする。
function DoneSection({ runs }: { runs: JoinedProgressFile[] }) {
  return (
    <details className="group border border-[var(--hairline)] px-5 py-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-mono-caps text-[11px] text-[var(--ink-muted)] transition hover:text-[var(--ink)] [&::-webkit-details-marker]:hidden">
        <span className="transition group-open:rotate-90">▶</span>
        完了 ({runs.length})
      </summary>
      <div className="mt-4 flex flex-col gap-6">
        {runs.map((run) => (
          <RunCard key={`${run.repo}#${run.issueNumber}`} run={run} />
        ))}
      </div>
    </details>
  );
}

function RunCard({ run }: { run: JoinedProgressFile }) {
  const escalated = hasEscalation(run);
  const escalatedNodes = run.nodes.filter((n) => n.escalation !== null);

  return (
    <section
      className="border px-5 py-4"
      style={
        escalated
          ? {
              borderColor: "color-mix(in srgb, var(--signal-alert) 45%, transparent)",
              backgroundColor: "color-mix(in srgb, var(--signal-alert) 5%, transparent)",
            }
          : { borderColor: "var(--hairline)" }
      }
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {escalated ? (
            <AlertOctagon size={14} className="shrink-0" style={{ color: "var(--signal-alert)" }} />
          ) : null}
          <h2 className="font-mono text-[13px] font-semibold text-[var(--ink)]">
            {run.repo}#{run.issueNumber} {run.title}
          </h2>
        </div>
        <span className="font-mono-caps text-[10px] text-[var(--ink-muted)]">{run.phase}</span>
      </header>

      {run.githubFetchError ? (
        <p className="mt-2 font-mono text-[11px]" style={{ color: "var(--signal-warn)" }}>
          github state unavailable: {run.githubFetchError}
        </p>
      ) : null}

      {run.escalation ? <EscalationNote escalation={run.escalation} /> : null}

      <RunGraphView run={run} />

      {escalatedNodes.map((node) => (
        <div key={node.key} className="mt-3">
          <p className="font-mono text-[11px] text-[var(--ink-dim)]">{node.title}</p>
          {node.escalation ? <EscalationNote escalation={node.escalation} /> : null}
        </div>
      ))}
    </section>
  );
}

// 依存の深さから座標が確定するので、SVG の辺も絶対配置の箱もサーバ側で描き切れる。
function RunGraphView({ run }: { run: JoinedProgressFile }) {
  const graph = layoutRunGraph(run.nodes);
  // marker id はドキュメント全体で一意にする(同一ページに複数の run が並ぶため)。
  const arrowId = `dep-arrow-${run.repo.replace(/[^a-zA-Z0-9]/g, "-")}-${run.issueNumber}`;

  return (
    <div className="mt-3 overflow-x-auto">
      <div className="relative" style={{ width: graph.width, height: graph.height }}>
        <svg
          className="absolute inset-0"
          width={graph.width}
          height={graph.height}
          aria-hidden="true"
        >
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 8 8"
              refX="8"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--hairline-strong)" />
            </marker>
          </defs>
          {graph.edges.map((edge) => (
            <line
              key={`${edge.fromKey}->${edge.toKey}`}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              stroke="var(--hairline-strong)"
              strokeWidth={1.5}
              markerEnd={`url(#${arrowId})`}
            />
          ))}
        </svg>
        {graph.nodes.map((g) => (
          <NodeBox key={g.node.key} node={g.node} x={g.x} y={g.y} />
        ))}
      </div>
    </div>
  );
}

// stage が進むほど gray → cyan → amber → green。blocked は段階に関わらず alert で塗る。
function nodeColor(stage: NodeStage, condition: NodeCondition): string {
  if (condition === "blocked") return "var(--signal-alert)";
  if (stage === "merged") return "var(--signal-ok)";
  if (stage === "review") return "var(--signal-warn)";
  if (stage === "implementing") return "var(--signal-info)";
  return "var(--signal-idle)";
}

function NodeBox({ node, x, y }: { node: JoinedNode; x: number; y: number }) {
  const stage = deriveStage(node);
  const condition = deriveCondition(node);
  const color = nodeColor(stage, condition);

  return (
    <div
      className="absolute box-border flex flex-col justify-center gap-1.5 border border-l-[3px] px-3 py-2"
      style={{
        left: x,
        top: y,
        width: BOX_W,
        height: BOX_H,
        borderColor: node.escalation !== null ? "var(--signal-alert)" : "var(--hairline)",
        borderLeftColor: color,
        backgroundColor: "var(--panel)",
      }}
    >
      <span className="truncate font-mono text-[11px] text-[var(--ink)]" title={node.title}>
        <span className="text-[var(--ink-faint)]">{node.key}</span> {node.title}
      </span>

      <span className="flex items-center gap-2">
        <StageRail stage={stage} color={color} />
        <span className="min-w-0 truncate font-mono-caps text-[9px]" style={{ color }}>
          {stageLabel(stage, condition)}
        </span>
      </span>

      <span className="h-[13px] truncate font-mono text-[10px] text-[var(--ink-muted)]">
        {node.activity ?? ""}
      </span>

      <span className="flex flex-wrap items-center gap-2">
        {node.githubPullRequest ? <PrBadge pr={node.githubPullRequest} /> : null}
        {node.githubIssue ? <IssueBadge issue={node.githubIssue} /> : null}
      </span>
    </div>
  );
}

// 4点レール。到達済みの段階まで色を塗り、現在地のドットにリングを付ける。
function StageRail({ stage, color }: { stage: NodeStage; color: string }) {
  const current = STAGES.indexOf(stage);
  return (
    <span className="flex w-[68px] shrink-0 items-center" aria-hidden="true">
      {STAGES.map((s, i) => (
        <Fragment key={s}>
          {i > 0 ? (
            <span
              className="h-px flex-1"
              style={{ backgroundColor: i <= current ? color : "var(--hairline)" }}
            />
          ) : null}
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{
              backgroundColor: i <= current ? color : "var(--hairline)",
              boxShadow:
                i === current
                  ? `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`
                  : undefined,
            }}
          />
        </Fragment>
      ))}
    </span>
  );
}

function EscalationNote({ escalation }: { escalation: ProgressEscalation }) {
  return (
    <div
      className="mt-2 border-l-2 pl-3 font-mono text-[11px]"
      style={{ borderColor: "var(--signal-alert)", color: "var(--ink-dim)" }}
    >
      <p style={{ color: "var(--signal-alert)" }}>
        {escalation.reason} · {escalation.detail}
      </p>
      <p className="mt-1">recommendation: {escalation.recommendation}</p>
    </div>
  );
}

function PrBadge({ pr }: { pr: NonNullable<JoinedNode["githubPullRequest"]> }) {
  const label = pr.state === "MERGED" ? "merged" : pr.isDraft ? "draft" : pr.state.toLowerCase();
  const color =
    pr.state === "MERGED"
      ? "var(--signal-ok)"
      : pr.mergeable === "CONFLICTING"
        ? "var(--signal-alert)"
        : "var(--signal-idle)";
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-[10px] underline"
      style={{ color }}
    >
      PR #{pr.number} · {label}
    </a>
  );
}

function IssueBadge({ issue }: { issue: NonNullable<JoinedNode["githubIssue"]> }) {
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-[10px] text-[var(--ink-muted)] underline"
    >
      issue #{issue.number} · {issue.state.toLowerCase()}
    </a>
  );
}
