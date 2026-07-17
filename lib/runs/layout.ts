import type { JoinedNode } from "@/lib/github/runJoin";

/**
 * run 内のノードを「左→右の依存グラフ」として描くためのレイアウト計算。
 *
 * 列幅・行高を固定値にすることで、依存の深さと列内の行番号から全ノードの座標が
 * サーバ側で確定する。これによりグラフライブラリもクライアント JS も要らず、
 * レンズはサーバコンポーネントのまま SVG の辺を描ける。
 *
 * 交差最小化は行わない。実データの DAG は浅く(深さ 2 程度)、必要になっていない。
 */

export const BOX_W = 236;
export const BOX_H = 88;
export const COL_GAP = 64;
export const ROW_GAP = 8;

export type GraphNode = {
  node: JoinedNode;
  col: number;
  row: number;
  x: number;
  y: number;
};

export type GraphEdge = {
  fromKey: string;
  toKey: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type RunGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
};

/** dependsOn を辿った最大深さ。循環していても無限再帰しないよう経路を渡す。 */
function nodeDepth(
  node: JoinedNode,
  byKey: Map<string, JoinedNode>,
  path: Set<string> = new Set(),
): number {
  if (node.dependsOn.length === 0 || path.has(node.key)) return 0;
  const nextPath = new Set(path).add(node.key);
  const depths = node.dependsOn.map((depKey) => {
    const dep = byKey.get(depKey);
    return dep ? nodeDepth(dep, byKey, nextPath) + 1 : 0;
  });
  return Math.max(...depths);
}

export function layoutRunGraph(nodes: JoinedNode[]): RunGraph {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const fileIndex = new Map(nodes.map((n, i) => [n.key, i]));
  const colOf = new Map(nodes.map((n) => [n.key, nodeDepth(n, byKey)]));
  const rowOf = new Map<string, number>();

  const maxCol = Math.max(0, ...nodes.map((n) => colOf.get(n.key) ?? 0));

  // 列を左から順に確定させる。子の行は「親の行」を第一キー・記載順を第二キーに決め、
  // 既に埋まっている行なら下へ詰める。
  for (let col = 0; col <= maxCol; col++) {
    const group = nodes.filter((n) => colOf.get(n.key) === col);
    const desired = new Map<string, number>();
    for (const n of group) {
      const parentRows = n.dependsOn
        .map((key) => rowOf.get(key))
        .filter((row): row is number => row !== undefined);
      desired.set(n.key, parentRows.length > 0 ? Math.min(...parentRows) : 0);
    }
    const ordered = [...group].sort(
      (a, b) =>
        (desired.get(a.key) ?? 0) - (desired.get(b.key) ?? 0) ||
        (fileIndex.get(a.key) ?? 0) - (fileIndex.get(b.key) ?? 0),
    );
    const used = new Set<number>();
    for (const n of ordered) {
      let row = desired.get(n.key) ?? 0;
      while (used.has(row)) row++;
      used.add(row);
      rowOf.set(n.key, row);
    }
  }

  const graphNodes: GraphNode[] = nodes.map((n) => {
    const col = colOf.get(n.key) ?? 0;
    const row = rowOf.get(n.key) ?? 0;
    return { node: n, col, row, x: col * (BOX_W + COL_GAP), y: row * (BOX_H + ROW_GAP) };
  });
  const posOf = new Map(graphNodes.map((g) => [g.node.key, g]));

  const edges: GraphEdge[] = [];
  for (const g of graphNodes) {
    for (const depKey of g.node.dependsOn) {
      const parent = posOf.get(depKey);
      if (!parent) continue;
      edges.push({
        fromKey: depKey,
        toKey: g.node.key,
        x1: parent.x + BOX_W,
        y1: parent.y + BOX_H / 2,
        x2: g.x,
        y2: g.y + BOX_H / 2,
      });
    }
  }

  return {
    nodes: graphNodes,
    edges,
    width: Math.max(0, ...graphNodes.map((g) => g.x + BOX_W)),
    height: Math.max(0, ...graphNodes.map((g) => g.y + BOX_H)),
  };
}
