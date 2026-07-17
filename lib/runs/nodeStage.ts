import type { JoinedNode } from "@/lib/github/runJoin";

/**
 * 進捗ファイルの liveStatus は段階(queued/implementing/reviewing)・条件(blocked)・
 * PR 依存(handed_off)が 1 つの enum に同居している。ステージレールを描くために、
 * cockpit 側の導出だけで「段階」と「条件」に分解する(進捗ファイルのスキーマは変えない)。
 */

export type NodeStage = "queued" | "implementing" | "review" | "merged";

export type NodeCondition = "normal" | "blocked" | "ok";

/** レールの並び順(左→右) */
export const STAGES: readonly NodeStage[] = ["queued", "implementing", "review", "merged"];

/**
 * 「証明できる最高段階」を返す。進捗ファイルは履歴を持たないため、blocked になった時点で
 * それ以前の段階は原理的に復元できない。よって推測せず、手元の事実から証明できる段階だけを採る。
 * 上から順に評価し、最初に当たったものを採用する。
 */
export function deriveStage(node: JoinedNode): NodeStage {
  if (node.githubPullRequest?.state === "MERGED") return "merged";
  if (node.githubPullRequest !== null) return "review";
  if (node.liveStatus === "implementing") return "implementing";
  return "queued";
}

/** stage と直交する条件。blocked は段階を持たない条件なのでここで表す。 */
export function deriveCondition(node: JoinedNode): NodeCondition {
  if (node.githubPullRequest?.state === "MERGED") return "ok";
  if (node.liveStatus === "blocked" || node.githubPullRequest?.mergeable === "CONFLICTING") {
    return "blocked";
  }
  return "normal";
}

/** blocked は段階を持たないため「条件＠段階」で表示する。 */
export function stageLabel(stage: NodeStage, condition: NodeCondition): string {
  return condition === "blocked" ? `blocked @ ${stage}` : stage;
}
