# progress レンズ 依存グラフ + ステージレール Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** progress レンズの run 内表示を、縦一列のリストから「左→右の依存グラフ + ノード内ステージレール」に置き換える。

**Architecture:** 描画に必要な計算を 2 つの純関数モジュール (`lib/runs/nodeStage.ts` = 段階/条件の導出、`lib/runs/layout.ts` = 依存レイヤリングと座標) に切り出し、`app/_components/ProgressLens.tsx` はその結果を SVG + 絶対配置の箱として描くだけにする。列幅・行高が固定値なので座標がサーバ側で確定し、グラフライブラリもクライアント JS も不要。

**Tech Stack:** Next.js (Server Components), TypeScript, Tailwind CSS v4 (CSS 変数トークン), vitest, lucide-react

## Global Constraints

- **進捗ファイルのスキーマ (`lib/runs/progress.ts`) を変更しない。** 段階/条件は cockpit 側の導出だけで解く
- **クライアント JS を増やさない。** `ProgressLens` はサーバコンポーネントのまま。`"use client"` を足さない
- **グラフライブラリ (dagre / elkjs / React Flow 等) を導入しない。** 依存を追加しない
- **色は必ず CSS 変数トークンで参照する** (`var(--signal-alert)` 等)。16進のリテラルを書かない。トークンは `app/globals.css` 定義でライト/ダーク両テーマに対応済み
- **このリポジトリは public。** コード・コメント・commit メッセージに Findy のリポジトリ名/issue タイトル等の社内情報を書かない。テストのフィクスチャは `owner/name` のような汎用値を使う
- パッケージマネージャは **pnpm** (npm ではない)
- 設計の根拠: `docs/superpowers/specs/2026-07-17-progress-dep-graph-design.md`

## File Structure

| ファイル | 責務 |
|---|---|
| `lib/runs/nodeStage.ts` (新規) | `JoinedNode` → 段階 (`NodeStage`) と条件 (`NodeCondition`) の導出、表示ラベル生成 |
| `lib/runs/__tests__/nodeStage.test.ts` (新規) | 上の導出規則のテスト |
| `lib/runs/layout.ts` (新規) | 依存の深さ→列、行割り当て、箱と辺の座標計算 |
| `lib/runs/__tests__/layout.test.ts` (新規) | レイヤリング・行割り当て・循環のテスト |
| `app/_components/ProgressLens.tsx` (修正) | グラフ描画に差し替え。`nodeDepth` / `NodeRow` / `LiveStatusBadge` を削除 |

---

### Task 1: 段階と条件の導出

`liveStatus` は段階 (`queued`/`implementing`/`reviewing`)・条件 (`blocked`)・PR 依存 (`handed_off`) が同居した enum。これを「証明できる最高段階」と「直交する条件」に分解する純関数を作る。

**Files:**
- Create: `lib/runs/nodeStage.ts`
- Test: `lib/runs/__tests__/nodeStage.test.ts`

**Interfaces:**
- Consumes: `JoinedNode` (`lib/github/runJoin.ts`), `GhPullRequestState` (`lib/github/types.ts`)
- Produces:
  - `type NodeStage = "queued" | "implementing" | "review" | "merged"`
  - `type NodeCondition = "normal" | "blocked" | "ok"`
  - `const STAGES: readonly NodeStage[]` — レールの左→右の並び順
  - `function deriveStage(node: JoinedNode): NodeStage`
  - `function deriveCondition(node: JoinedNode): NodeCondition`
  - `function stageLabel(stage: NodeStage, condition: NodeCondition): string`

- [ ] **Step 1: 失敗するテストを書く**

`lib/runs/__tests__/nodeStage.test.ts` を新規作成:

```ts
import { describe, expect, it } from "vitest";
import { deriveCondition, deriveStage, stageLabel } from "../nodeStage";
import type { JoinedNode } from "@/lib/github/runJoin";
import type { GhPullRequestState } from "@/lib/github/types";

function node(overrides: Partial<JoinedNode> = {}): JoinedNode {
  return {
    key: "t1",
    title: "サブタスク",
    dependsOn: [],
    liveStatus: "queued",
    subIssue: null,
    prNumber: null,
    escalation: null,
    githubIssue: null,
    githubPullRequest: null,
    ...overrides,
  };
}

function pr(overrides: Partial<GhPullRequestState> = {}): GhPullRequestState {
  return {
    number: 1,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    url: "https://example.test/pr/1",
    ...overrides,
  };
}

describe("deriveStage", () => {
  it("PR が MERGED なら merged (liveStatus より優先する)", () => {
    const n = node({ liveStatus: "implementing", githubPullRequest: pr({ state: "MERGED" }) });
    expect(deriveStage(n)).toBe("merged");
  });

  it("PR が存在すれば review (実装は出ている証拠)", () => {
    expect(deriveStage(node({ githubPullRequest: pr({ state: "OPEN" }) }))).toBe("review");
  });

  it("PR が CLOSED でも存在すれば review", () => {
    expect(deriveStage(node({ githubPullRequest: pr({ state: "CLOSED" }) }))).toBe("review");
  });

  it("PR が無く liveStatus が implementing なら implementing", () => {
    expect(deriveStage(node({ liveStatus: "implementing" }))).toBe("implementing");
  });

  it("PR が無く liveStatus が queued なら queued", () => {
    expect(deriveStage(node({ liveStatus: "queued" }))).toBe("queued");
  });

  it("blocked は段階を持たないので、進んだ証拠がなければ queued に落ちる", () => {
    expect(deriveStage(node({ liveStatus: "blocked" }))).toBe("queued");
  });

  it("blocked でも PR があれば review まで証明できる", () => {
    const n = node({ liveStatus: "blocked", githubPullRequest: pr({ state: "OPEN" }) });
    expect(deriveStage(n)).toBe("review");
  });

  it("PR 番号を持たないまま handed_off を名乗るノードは queued に落ちる (書き手側の記述漏れを可視化する)", () => {
    expect(deriveStage(node({ liveStatus: "handed_off" }))).toBe("queued");
  });

  it("PR 番号を持たないまま reviewing を名乗るノードは queued に落ちる", () => {
    expect(deriveStage(node({ liveStatus: "reviewing" }))).toBe("queued");
  });

  it("prNumber があっても GitHub 取得失敗で join できていなければ liveStatus だけで決まる", () => {
    const n = node({ liveStatus: "implementing", prNumber: 99, githubPullRequest: null });
    expect(deriveStage(n)).toBe("implementing");
  });
});

describe("deriveCondition", () => {
  it("PR が MERGED なら ok", () => {
    expect(deriveCondition(node({ githubPullRequest: pr({ state: "MERGED" }) }))).toBe("ok");
  });

  it("liveStatus が blocked なら blocked", () => {
    expect(deriveCondition(node({ liveStatus: "blocked" }))).toBe("blocked");
  });

  it("PR が CONFLICTING なら blocked", () => {
    const n = node({ liveStatus: "implementing", githubPullRequest: pr({ mergeable: "CONFLICTING" }) });
    expect(deriveCondition(n)).toBe("blocked");
  });

  it("平常時は normal", () => {
    expect(deriveCondition(node({ liveStatus: "implementing" }))).toBe("normal");
  });
});

describe("stageLabel", () => {
  it("blocked は条件＠段階で表す", () => {
    expect(stageLabel("queued", "blocked")).toBe("blocked @ queued");
    expect(stageLabel("review", "blocked")).toBe("blocked @ review");
  });

  it("blocked でなければ段階名をそのまま出す", () => {
    expect(stageLabel("implementing", "normal")).toBe("implementing");
    expect(stageLabel("merged", "ok")).toBe("merged");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm exec vitest run lib/runs/__tests__/nodeStage.test.ts`
Expected: FAIL — `Failed to resolve import "../nodeStage"`

- [ ] **Step 3: 最小の実装を書く**

`lib/runs/nodeStage.ts` を新規作成:

```ts
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
```

- [ ] **Step 4: テストを実行して通ることを確認**

Run: `pnpm exec vitest run lib/runs/__tests__/nodeStage.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: コミット**

```bash
git add lib/runs/nodeStage.ts lib/runs/__tests__/nodeStage.test.ts
git commit -m "feat(progress): liveStatus を段階と条件に分解する導出を追加 (#172)"
```

---

### Task 2: 依存レイヤリングと座標計算

依存の深さを列に、親の行に子を寄せる規則で行を決め、箱と辺の座標を確定させる。`nodeDepth` は現在 `ProgressLens.tsx` にあるものをここへ移す（挙動は変えない。循環時に無限再帰しないことをテストで保証する）。

**Files:**
- Create: `lib/runs/layout.ts`
- Test: `lib/runs/__tests__/layout.test.ts`

**Interfaces:**
- Consumes: `JoinedNode` (`lib/github/runJoin.ts`)
- Produces:
  - `const BOX_W: 236`, `BOX_H: 88`, `COL_GAP: 64`, `ROW_GAP: 8`
  - `type GraphNode = { node: JoinedNode; col: number; row: number; x: number; y: number }`
  - `type GraphEdge = { fromKey: string; toKey: string; x1: number; y1: number; x2: number; y2: number }`
  - `type RunGraph = { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number }`
  - `function layoutRunGraph(nodes: JoinedNode[]): RunGraph`

- [ ] **Step 1: 失敗するテストを書く**

`lib/runs/__tests__/layout.test.ts` を新規作成:

```ts
import { describe, expect, it } from "vitest";
import { BOX_H, BOX_W, COL_GAP, ROW_GAP, layoutRunGraph } from "../layout";
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

function colOf(graph: ReturnType<typeof layoutRunGraph>, key: string): number {
  const found = graph.nodes.find((g) => g.node.key === key);
  if (!found) throw new Error(`node ${key} not found`);
  return found.col;
}

function rowOf(graph: ReturnType<typeof layoutRunGraph>, key: string): number {
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
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm exec vitest run lib/runs/__tests__/layout.test.ts`
Expected: FAIL — `Failed to resolve import "../layout"`

- [ ] **Step 3: 最小の実装を書く**

`lib/runs/layout.ts` を新規作成:

```ts
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
function nodeDepth(node: JoinedNode, byKey: Map<string, JoinedNode>, path: Set<string> = new Set()): number {
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
```

- [ ] **Step 4: テストを実行して通ることを確認**

Run: `pnpm exec vitest run lib/runs/__tests__/layout.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: コミット**

```bash
git add lib/runs/layout.ts lib/runs/__tests__/layout.test.ts
git commit -m "feat(progress): 依存レイヤリングと座標計算を追加 (#172)"
```

---

### Task 3: ProgressLens をグラフ描画に差し替える

`<ol>` + インデントの `NodeRow` を、SVG の辺 + 絶対配置の箱に置き換える。`nodeDepth` は Task 2 に移したので `ProgressLens.tsx` からは削除する。

**Files:**
- Modify: `app/_components/ProgressLens.tsx`

**Interfaces:**
- Consumes: Task 1 の `STAGES` / `deriveStage` / `deriveCondition` / `stageLabel` / `NodeStage` / `NodeCondition`、Task 2 の `layoutRunGraph` / `BOX_W` / `BOX_H`
- Produces: なし (この画面で閉じる)

- [ ] **Step 1: RunCard をグラフに差し替える**

`app/_components/ProgressLens.tsx` の先頭の import を差し替える:

```tsx
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
```

（`LiveStatus` 型の import は不要になるので消す。`ProgressEscalation` は `EscalationNote` でまだ使う。）

`nodeDepth` 関数（21-30 行目付近）を丸ごと削除する。

`RunCard` の中身を差し替える。`<ol>` のブロックを `RunGraphView` の呼び出しに置き換え、ノードの escalation はグラフの下に出す:

```tsx
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
```

- [ ] **Step 2: グラフ描画コンポーネントを書く**

`RunCard` の直後に追加する。SVG の marker id は run ごとに一意にする（同一ページに複数の run が並ぶため）:

```tsx
// 依存の深さから座標が確定するので、SVG の辺も絶対配置の箱もサーバ側で描き切れる。
function RunGraphView({ run }: { run: JoinedProgressFile }) {
  const graph = layoutRunGraph(run.nodes);
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
```

- [ ] **Step 3: ノードの箱を書く**

`NodeRow` と `LiveStatusBadge` を削除し、代わりに以下を追加する:

```tsx
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
        <span className="truncate font-mono-caps text-[9px]" style={{ color }}>
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
                i === current ? `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)` : undefined,
            }}
          />
        </Fragment>
      ))}
    </span>
  );
}
```

（`PrBadge` / `IssueBadge` / `EscalationNote` / `hasEscalation` / `DoneSection` / `ProgressLens` 本体はそのまま残す。）

- [ ] **Step 4: 型チェックと lint とテストを通す**

Run: `pnpm exec tsc --noEmit`
Expected: エラーなし

Run: `pnpm lint`
Expected: エラーなし

Run: `pnpm test`
Expected: 全て PASS（既存の `progress.test.ts` / `list` 系も含めて退行していないこと）

- [ ] **Step 5: 実データで動作を確認**

Run: `pnpm dev`

ブラウザで `http://localhost:7878/progress` を開き、以下を目視で確認する:

1. 依存を持つ run で、親の箱から子の箱へ線が引かれている
2. 依存ゼロの run も同じ見た目（線が無いだけ）で描かれている
3. blocked のノードが赤く、`blocked @ <段階>` と出ている
4. 依存待ちの blocked（線がある）と外部要因の blocked（線が無い）が絵で区別できる
5. `activity` を持つノードでその一行が出ている
6. 完了 (done) の折りたたみセクションが従来どおり動く
7. ライトテーマ（画面のテーマ切り替え）でも色が破綻しない

確認できたら dev サーバを止める。**バックグラウンドで起動したまま放置しない**（Turbopack のプロセスが増殖する既知の問題がある）。

- [ ] **Step 6: コミット**

```bash
git add app/_components/ProgressLens.tsx
git commit -m "feat(progress): run 内を依存グラフ + ステージレールで描く (#172)"
```

---

## 完了後

`/code-review` をローカルで実行し、指摘をトリアージして反映してから push、`gh pr create --draft` で Draft PR を作る。
