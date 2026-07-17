import { describe, expect, it } from "vitest";
import { BOX_H, BOX_W, COL_GAP, ROW_GAP, layoutRunGraph } from "../layout";
import type { RunGraph } from "../layout";
import type { JoinedNode } from "@/lib/github/runJoin";

function node(key: string, dependsOn: string[] = []): JoinedNode {
  return {
    key,
    title: `タスク ${key}`,
    dependsOn,
    liveStatus: "queued",
    subIssue: null,
    prNumber: null,
    escalation: null,
    githubIssue: null,
    githubPullRequest: null,
  };
}

function colOf(graph: RunGraph, key: string): number {
  const found = graph.nodes.find((g) => g.node.key === key);
  if (!found) throw new Error(`node ${key} not found`);
  return found.col;
}

function rowOf(graph: RunGraph, key: string): number {
  const found = graph.nodes.find((g) => g.node.key === key);
  if (!found) throw new Error(`node ${key} not found`);
  return found.row;
}

describe("layoutRunGraph", () => {
  it("空の run は空のグラフになる", () => {
    const graph = layoutRunGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.width).toBe(0);
    expect(graph.height).toBe(0);
  });

  it("依存ゼロのノードは全て列 0 に、記載順で縦に並ぶ", () => {
    const graph = layoutRunGraph([node("a"), node("b"), node("c")]);
    expect(graph.nodes.map((g) => g.col)).toEqual([0, 0, 0]);
    expect(rowOf(graph, "a")).toBe(0);
    expect(rowOf(graph, "b")).toBe(1);
    expect(rowOf(graph, "c")).toBe(2);
    expect(graph.edges).toEqual([]);
  });

  it("依存の深さが列になる", () => {
    const graph = layoutRunGraph([node("a"), node("b", ["a"]), node("c", ["b"])]);
    expect(colOf(graph, "a")).toBe(0);
    expect(colOf(graph, "b")).toBe(1);
    expect(colOf(graph, "c")).toBe(2);
  });

  it("子は親と同じ行に寄る", () => {
    // a(row0) b(row1) は列 0。c は b に依存するので列 1 の row1 に来る。
    const graph = layoutRunGraph([node("a"), node("b"), node("c", ["b"])]);
    expect(rowOf(graph, "b")).toBe(1);
    expect(colOf(graph, "c")).toBe(1);
    expect(rowOf(graph, "c")).toBe(1);
  });

  it("同じ親を持つ子が競合したら下に詰む", () => {
    const graph = layoutRunGraph([node("a"), node("b", ["a"]), node("c", ["a"])]);
    expect(rowOf(graph, "a")).toBe(0);
    expect(rowOf(graph, "b")).toBe(0);
    expect(rowOf(graph, "c")).toBe(1);
  });

  it("複数の親を持つノードは最小の親の行に寄る", () => {
    // a(row0) b(row1) はどちらも列 0。c は両方に依存 → 列 1 の row0。
    const graph = layoutRunGraph([node("a"), node("b"), node("c", ["a", "b"])]);
    expect(rowOf(graph, "c")).toBe(0);
  });

  it("辺は親の右辺中央から子の左辺中央へ引かれる", () => {
    const graph = layoutRunGraph([node("a"), node("b", ["a"])]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      fromKey: "a",
      toKey: "b",
      x1: BOX_W,
      y1: BOX_H / 2,
      x2: BOX_W + COL_GAP,
      y2: BOX_H / 2,
    });
  });

  it("存在しないキーへの依存は辺にならない (壊れたファイルでも落とさない)", () => {
    const graph = layoutRunGraph([node("a", ["missing"])]);
    expect(graph.edges).toEqual([]);
    expect(colOf(graph, "a")).toBe(0);
  });

  it("座標は列幅・行高の固定値から決まる", () => {
    const graph = layoutRunGraph([node("a"), node("b")]);
    expect(graph.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(graph.nodes[1]).toMatchObject({ x: 0, y: BOX_H + ROW_GAP });
  });

  it("width / height は最も右下の箱の端になる", () => {
    const graph = layoutRunGraph([node("a"), node("b", ["a"])]);
    expect(graph.width).toBe(BOX_W + COL_GAP + BOX_W);
    expect(graph.height).toBe(BOX_H);
  });

  it("循環していても無限再帰せず有限の列に収まる", () => {
    const graph = layoutRunGraph([node("a", ["b"]), node("b", ["a"])]);
    expect(graph.nodes).toHaveLength(2);
    for (const g of graph.nodes) {
      expect(Number.isFinite(g.col)).toBe(true);
      expect(Number.isFinite(g.row)).toBe(true);
    }
  });

  it("自己参照していても無限再帰しない", () => {
    const graph = layoutRunGraph([node("a", ["a"])]);
    expect(graph.nodes).toHaveLength(1);
    expect(Number.isFinite(colOf(graph, "a"))).toBe(true);
  });
});
