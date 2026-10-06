import { describe, expect, it } from "vitest";
import { buildStackIndex, groupByStack } from "../stack";

function pr(number: number, head: string, base: string, repo = "owner/name") {
  return {
    id: `PR_${number}`,
    number,
    repositoryNameWithOwner: repo,
    headBranchLabel: head,
    baseRefName: base,
  };
}

describe("buildStackIndex", () => {
  it("base = 別の PR の head をたどってベースから段数を振る", () => {
    const index = buildStackIndex([pr(3, "c", "b"), pr(1, "a", "main"), pr(2, "b", "a")]);
    expect(index.get("PR_1")).toEqual({ rootId: "PR_1", position: 1, size: 3, parentNumber: null });
    expect(index.get("PR_2")).toEqual({ rootId: "PR_1", position: 2, size: 3, parentNumber: 1 });
    expect(index.get("PR_3")).toEqual({ rootId: "PR_1", position: 3, size: 3, parentNumber: 2 });
  });

  it("どこにも積まれていない PR は stack にしない", () => {
    const index = buildStackIndex([pr(1, "a", "main"), pr(2, "b", "main")]);
    expect(index.size).toBe(0);
  });

  it("別リポジトリの同名ブランチはつながない", () => {
    const index = buildStackIndex([pr(1, "a", "main", "owner/x"), pr(2, "b", "a", "owner/y")]);
    expect(index.size).toBe(0);
  });

  it("途中の PR が一覧に無ければそこで切れる", () => {
    // b の PR が無いので c は a につながらない
    const index = buildStackIndex([pr(1, "a", "main"), pr(3, "c", "b"), pr(4, "d", "c")]);
    expect(index.has("PR_1")).toBe(false);
    expect(index.get("PR_3")?.position).toBe(1);
    expect(index.get("PR_4")).toMatchObject({ rootId: "PR_3", position: 2, size: 2 });
  });

  it("ブランチが循環していても無限ループにならない", () => {
    expect(() => buildStackIndex([pr(1, "a", "b"), pr(2, "b", "a")])).not.toThrow();
  });
});

describe("groupByStack", () => {
  it("同じ stack を最初に出てきた位置に集め、ベースから順に並べる", () => {
    const cards = [pr(3, "c", "b"), pr(9, "x", "main"), pr(1, "a", "main"), pr(2, "b", "a")];
    const groups = groupByStack(cards, buildStackIndex(cards));
    expect(groups).toEqual([
      { kind: "stack", rootId: "PR_1", cards: [cards[2], cards[3], cards[0]] },
      { kind: "single", card: cards[1] },
    ]);
  });

  it("枝分かれしたら枝ごとに上までたどってから次の枝に移る", () => {
    // 1 の上に 2 と 3、2 の上に 4
    const cards = [pr(1, "a", "main"), pr(3, "c", "a"), pr(2, "b", "a"), pr(4, "d", "b")];
    const [group] = groupByStack(cards, buildStackIndex(cards));
    expect(group.kind === "stack" && group.cards.map((c) => c.number)).toEqual([1, 2, 4, 3]);
  });

  it("区分に stack の 1 件だけなら単独のカードとして出す", () => {
    const all = [pr(1, "a", "main"), pr(2, "b", "a")];
    const groups = groupByStack([all[1]], buildStackIndex(all));
    expect(groups).toEqual([{ kind: "single", card: all[1] }]);
  });
});
