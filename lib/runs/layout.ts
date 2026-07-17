import type { JoinedNode } from "@/lib/github/runJoin";

/**
 * run 内のノードを「左→右の依存グラフ」として描くためのレイアウト計算。
 *
 * 列幅・行高を固定値にすることで、依存の深さと列内の行番号から全ノードの座標が
 * サーバ側で確定する。これによりグラフライブラリもクライアント JS も要らず、
 * レンズはサーバコンポーネントのまま SVG の辺を描ける。
 *
 * 交差最小化は行わない。実データの DAG は浅く(深さ 2 程度)、必要になっていない。
 *
 * 位置決めは node.key ではなく配列 index で行う。進捗ファイルは key の一意性を
 * 保証しておらず(parseProgress は型しか見ない)、key で位置を持つと重複した
 * ノードが同じ座標に重なって片方が消える(＝サイレントなデータ欠落)ため。
 * key は dependsOn の解決にだけ使い、重複時は最初に現れたノードに繋ぐ。
 */

export const BOX_W = 300;
// 箱は 4 行(タイトル / レール / activity / バッジ)を潰さずに収める高さが要る。
// 下回ると flex が行を縮めてグリフが切れる(実測: 中身は ~98px)。
export const BOX_H = 104;
export const COL_GAP = 64;
export const ROW_GAP = 8;

export type GraphNode = {
  /** React key 兼、辺の端点参照に使う一意 id(node.key は重複しうるので使えない) */
  id: string;
  node: JoinedNode;
  col: number;
  row: number;
  x: number;
  y: number;
};

export type GraphEdge = {
  /** React key。同じ端点の組が dependsOn の重複で二度現れても 1 本に畳む */
  id: string;
  fromKey: string;
  toKey: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type RunGraph = {
  /** (col, row) 順。DOM 順と見た目の順を一致させ、キーボードの移動順を自然に保つ */
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
};

/** dependsOn を辿った最大深さ。循環していても無限再帰しないよう経路(index 集合)を渡す。 */
function depthOf(
  index: number,
  nodes: JoinedNode[],
  firstIndexOfKey: Map<string, number>,
  path: Set<number>,
): number {
  const node = nodes[index];
  if (node.dependsOn.length === 0 || path.has(index)) return 0;
  const nextPath = new Set(path).add(index);
  const depths = node.dependsOn.map((depKey) => {
    const depIndex = firstIndexOfKey.get(depKey);
    return depIndex === undefined ? 0 : depthOf(depIndex, nodes, firstIndexOfKey, nextPath) + 1;
  });
  return Math.max(...depths);
}

export function layoutRunGraph(nodes: JoinedNode[]): RunGraph {
  const firstIndexOfKey = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (!firstIndexOfKey.has(n.key)) firstIndexOfKey.set(n.key, i);
  });

  const rawCols = nodes.map((_, i) => depthOf(i, nodes, firstIndexOfKey, new Set()));
  // 循環があると全メンバーの深さが押し上がり、左側の列が丸ごと空になって
  // 「スクロールしないとノードが見えない空白」になる。使われている最小の列を 0 に寄せる。
  const minCol = rawCols.length > 0 ? Math.min(...rawCols) : 0;
  const cols = rawCols.map((c) => c - minCol);

  const maxCol = cols.length > 0 ? Math.max(...cols) : 0;
  const rows = new Array<number>(nodes.length).fill(0);
  const assigned = new Set<number>();

  // 列を左から順に確定させる。子の行は「親の行」を第一キー・記載順を第二キーに決め、
  // 既に埋まっている行なら下へ詰める。
  for (let col = 0; col <= maxCol; col++) {
    const group: number[] = [];
    cols.forEach((c, i) => {
      if (c === col) group.push(i);
    });

    const desired = new Map<number, number>();
    for (const i of group) {
      const parentRows = nodes[i].dependsOn
        .map((key) => firstIndexOfKey.get(key))
        .filter((p): p is number => p !== undefined && assigned.has(p))
        .map((p) => rows[p]);
      desired.set(i, parentRows.length > 0 ? Math.min(...parentRows) : 0);
    }

    const ordered = [...group].sort((a, b) => (desired.get(a) ?? 0) - (desired.get(b) ?? 0) || a - b);
    const used = new Set<number>();
    for (const i of ordered) {
      let row = desired.get(i) ?? 0;
      while (used.has(row)) row++;
      used.add(row);
      rows[i] = row;
      assigned.add(i);
    }
  }

  const byIndex: GraphNode[] = nodes.map((node, i) => ({
    id: String(i),
    node,
    col: cols[i],
    row: rows[i],
    x: cols[i] * (BOX_W + COL_GAP),
    y: rows[i] * (BOX_H + ROW_GAP),
  }));

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  byIndex.forEach((child, i) => {
    for (const depKey of child.node.dependsOn) {
      const p = firstIndexOfKey.get(depKey);
      // 自己参照は辺にしない(右辺から自分の左辺へ引くと後ろ向きの線になる)
      if (p === undefined || p === i) continue;
      const id = `${p}->${i}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const parent = byIndex[p];
      edges.push({
        id,
        fromKey: parent.node.key,
        toKey: child.node.key,
        x1: parent.x + BOX_W,
        y1: parent.y + BOX_H / 2,
        x2: child.x,
        y2: child.y + BOX_H / 2,
      });
    }
  });

  return {
    nodes: [...byIndex].sort((a, b) => a.col - b.col || a.row - b.row),
    edges,
    width: Math.max(0, ...byIndex.map((g) => g.x + BOX_W)),
    height: Math.max(0, ...byIndex.map((g) => g.y + BOX_H)),
  };
}
