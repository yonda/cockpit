import { cache } from "react";
import { AlertOctagon } from "lucide-react";
import { listProgressFiles } from "@/lib/runs/list";
import { joinProgressFilesWithGithub } from "@/lib/github/runJoin";
import type { JoinedNode, JoinedProgressFile } from "@/lib/github/runJoin";
import type { ProgressEscalation, LiveStatus } from "@/lib/runs/progress";
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

// dependsOn を辿った深さをインデントに使う。循環していても無限再帰しないよう経路を渡す。
function nodeDepth(node: JoinedNode, byKey: Map<string, JoinedNode>, path: Set<string> = new Set()): number {
  if (node.dependsOn.length === 0 || path.has(node.key)) return 0;
  const nextPath = new Set(path).add(node.key);
  const depths = node.dependsOn.map((depKey) => {
    const dep = byKey.get(depKey);
    return dep ? nodeDepth(dep, byKey, nextPath) + 1 : 0;
  });
  return Math.max(...depths);
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
  const byKey = new Map(run.nodes.map((n) => [n.key, n]));

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

      <ol className="mt-3 flex flex-col gap-2">
        {run.nodes.map((node) => (
          <NodeRow key={node.key} node={node} depth={nodeDepth(node, byKey)} />
        ))}
      </ol>
    </section>
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

function NodeRow({ node, depth }: { node: JoinedNode; depth: number }) {
  const escalated = node.escalation !== null;
  return (
    <li
      className="flex flex-col gap-1 border-l py-1 pl-3"
      style={{
        marginLeft: depth * 16,
        borderColor: escalated ? "var(--signal-alert)" : "var(--hairline)",
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-[var(--ink)]">{node.title}</span>
        <LiveStatusBadge status={node.liveStatus} />
        {node.githubPullRequest ? <PrBadge pr={node.githubPullRequest} /> : null}
        {node.githubIssue ? <IssueBadge issue={node.githubIssue} /> : null}
      </div>
      {node.activity ? (
        <p className="font-mono text-[11px] text-[var(--ink-muted)]">{node.activity}</p>
      ) : null}
      {node.escalation ? <EscalationNote escalation={node.escalation} /> : null}
    </li>
  );
}

function LiveStatusBadge({ status }: { status: LiveStatus }) {
  const color =
    status === "blocked"
      ? "var(--signal-alert)"
      : status === "handed_off"
        ? "var(--signal-ok)"
        : "var(--signal-info)";
  return (
    <span className="font-mono-caps text-[10px]" style={{ color }}>
      {status}
    </span>
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
