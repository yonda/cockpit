import type { PullRequestCard } from "./types";

export type StackInfo = {
  // stack のベース (一番下) の PR の id。同じ stack の目印に使う
  rootId: string;
  // ベースを 1 とした段数
  position: number;
  // stack 全体の PR 数
  size: number;
  // 1 つ下の PR の番号。ベースなら null
  parentNumber: number | null;
};

export type StackIndex = Map<string, StackInfo>;

type StackNode = Pick<
  PullRequestCard,
  "id" | "number" | "repositoryNameWithOwner" | "headBranchLabel" | "baseRefName"
>;

// 「ある PR の base = 別の PR の head」を親子としてたどり、2 件以上つながったものを stack とみなす。
// 一覧にある PR だけでつなぐので、途中の PR が一覧に無ければそこで切れる。
export function buildStackIndex(cards: StackNode[]): StackIndex {
  const byId = new Map<string, StackNode>();
  for (const card of cards) byId.set(card.id, card);
  const nodes = [...byId.values()];

  const byHead = new Map<string, StackNode>();
  for (const node of nodes) {
    byHead.set(`${node.repositoryNameWithOwner}\0${node.headBranchLabel}`, node);
  }
  const parentOf = (node: StackNode) =>
    byHead.get(`${node.repositoryNameWithOwner}\0${node.baseRefName}`);

  const chainOf = (node: StackNode): StackNode[] => {
    const chain = [node];
    const seen = new Set([node.id]);
    let parent = parentOf(node);
    while (parent && !seen.has(parent.id)) {
      chain.push(parent);
      seen.add(parent.id);
      parent = parentOf(parent);
    }
    return chain;
  };

  const chains = new Map(nodes.map((node) => [node.id, chainOf(node)]));
  const sizeByRoot = new Map<string, number>();
  for (const chain of chains.values()) {
    const rootId = chain[chain.length - 1].id;
    sizeByRoot.set(rootId, (sizeByRoot.get(rootId) ?? 0) + 1);
  }

  const index: StackIndex = new Map();
  for (const [id, chain] of chains) {
    const rootId = chain[chain.length - 1].id;
    const size = sizeByRoot.get(rootId) ?? 1;
    if (size < 2) continue;
    index.set(id, {
      rootId,
      position: chain.length,
      size,
      parentNumber: chain[1]?.number ?? null,
    });
  }
  return index;
}

export type CardGroup<T> =
  | { kind: "single"; card: T }
  | { kind: "stack"; rootId: string; cards: T[] };

// 並び順は崩さず、同じ stack の PR だけを最初に出てきた位置に集めてベースから順に並べる
export function groupByStack<T extends { id: string; number: number }>(
  cards: T[],
  index: StackIndex,
): CardGroup<T>[] {
  const groups: CardGroup<T>[] = [];
  const stackGroups = new Map<string, { kind: "stack"; rootId: string; cards: T[] }>();

  for (const card of cards) {
    const info = index.get(card.id);
    if (!info) {
      groups.push({ kind: "single", card });
      continue;
    }
    let group = stackGroups.get(info.rootId);
    if (!group) {
      group = { kind: "stack", rootId: info.rootId, cards: [] };
      stackGroups.set(info.rootId, group);
      groups.push(group);
    }
    group.cards.push(card);
  }

  for (const group of stackGroups.values()) {
    group.cards = orderFromBase(group.cards, index);
  }
  return groups.map((g) => (g.kind === "stack" && g.cards.length === 1 ? { kind: "single", card: g.cards[0] } : g));
}

// ベースから枝ごとに上までたどる順に並べる。枝分かれしても 1 本の枝が途切れずに続く
function orderFromBase<T extends { id: string; number: number }>(
  cards: T[],
  index: StackIndex,
): T[] {
  const numbers = new Set(cards.map((c) => c.number));
  const children = new Map<number | null, T[]>();
  for (const card of cards) {
    const parent = index.get(card.id)?.parentNumber ?? null;
    // 親がこの区分に無ければ、区分内では一番下として扱う
    const key = parent !== null && numbers.has(parent) ? parent : null;
    children.set(key, [...(children.get(key) ?? []), card]);
  }
  const ordered: T[] = [];
  const visit = (key: number | null) => {
    const list = (children.get(key) ?? []).sort((a, b) => a.number - b.number);
    for (const card of list) {
      ordered.push(card);
      visit(card.number);
    }
  };
  visit(null);
  return ordered;
}
