import type { PullRequestCard } from "./types";

export type StackInfo = {
  // stack のベース (一番下) の PR の id。同じ stack の目印に使う
  rootId: string;
  // ベースを 1 とした段数
  position: number;
  // stack の一番上の段数。枝分かれしていても同じ段は同じ数になる
  height: number;
  // 1 つ下の PR の番号。ベースなら null
  parentNumber: number | null;
};

export type StackIndex = Map<string, StackInfo>;

type StackNode = Pick<
  PullRequestCard,
  | "id"
  | "number"
  | "repositoryNameWithOwner"
  | "headBranchLabel"
  | "baseRefName"
  | "defaultBranchName"
>;

// develop や release/* のように長く使うブランチを head にした PR (リリース用の PR など) は、
// そこへ向けた PR がすべて「上に積まれた」ように見えてしまうので親にしない
const LONG_LIVED_BRANCH = /^(main|master|develop|development|staging|production|release([/-].*)?)$/;

function canBeParent(node: StackNode): boolean {
  if (node.headBranchLabel === node.defaultBranchName) return false;
  return !LONG_LIVED_BRANCH.test(node.headBranchLabel);
}

// 「ある PR の base = 別の PR の head」を親子としてたどり、2 件以上つながったものを stack とみなす。
// 一覧にある PR だけでつなぐので、途中の PR が一覧に無ければそこで切れる。
export function buildStackIndex(cards: StackNode[]): StackIndex {
  const byId = new Map<string, StackNode>();
  for (const card of cards) byId.set(card.id, card);
  const nodes = [...byId.values()];

  const keyOf = (repo: string, branch: string) => `${repo}\0${branch}`;
  // 同じ head ブランチの PR が複数あると親を決められないので、そのブランチではつながない
  const byHead = new Map<string, StackNode | null>();
  for (const node of nodes) {
    if (!canBeParent(node)) continue;
    const key = keyOf(node.repositoryNameWithOwner, node.headBranchLabel);
    byHead.set(key, byHead.has(key) ? null : node);
  }
  const parentOf = (node: StackNode) =>
    byHead.get(keyOf(node.repositoryNameWithOwner, node.baseRefName)) ?? undefined;

  // ベースまでたどった列を返す。ブランチが循環していたら stack として扱わない
  const chainOf = (node: StackNode): StackNode[] | null => {
    const chain = [node];
    const seen = new Set([node.id]);
    for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
      if (seen.has(parent.id)) return null;
      chain.push(parent);
      seen.add(parent.id);
    }
    return chain;
  };

  const chains = new Map<string, StackNode[]>();
  for (const node of nodes) {
    const chain = chainOf(node);
    if (chain) chains.set(node.id, chain);
  }

  const sizeByRoot = new Map<string, number>();
  const heightByRoot = new Map<string, number>();
  for (const chain of chains.values()) {
    const rootId = chain[chain.length - 1].id;
    sizeByRoot.set(rootId, (sizeByRoot.get(rootId) ?? 0) + 1);
    heightByRoot.set(rootId, Math.max(heightByRoot.get(rootId) ?? 0, chain.length));
  }

  const index: StackIndex = new Map();
  for (const [id, chain] of chains) {
    const rootId = chain[chain.length - 1].id;
    if ((sizeByRoot.get(rootId) ?? 0) < 2) continue;
    index.set(id, {
      rootId,
      position: chain.length,
      height: heightByRoot.get(rootId) ?? chain.length,
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
  return groups.map((g) =>
    g.kind === "stack" && g.cards.length === 1 ? { kind: "single", card: g.cards[0] } : g,
  );
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
    const siblings = children.get(key);
    if (siblings) siblings.push(card);
    else children.set(key, [card]);
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
