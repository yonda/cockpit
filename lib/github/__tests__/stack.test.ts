import { describe, expect, it } from "vitest";
import { buildStackIndex, groupByStack } from "../stack";

function pr(number: number, head: string, base: string, repo = "owner/name") {
  return {
    id: `PR_${number}`,
    number,
    repositoryNameWithOwner: repo,
    headBranchLabel: head,
    baseRefName: base,
    defaultBranchName: "main",
  };
}

describe("buildStackIndex", () => {
  it("base = 別の PR の head をたどってベースから段数を振る", () => {
    const index = buildStackIndex([pr(3, "c", "b"), pr(1, "a", "main"), pr(2, "b", "a")]);
    expect(index.get("PR_1")).toEqual({ rootId: "PR_1", position: 1, height: 3, parentNumber: null });
    expect(index.get("PR_2")).toEqual({ rootId: "PR_1", position: 2, height: 3, parentNumber: 1 });
    expect(index.get("PR_3")).toEqual({ rootId: "PR_1", position: 3, height: 3, parentNumber: 2 });
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
    expect(index.get("PR_4")).toMatchObject({ rootId: "PR_3", position: 2, height: 2 });
  });

  it("ブランチが循環していたら stack にしない", () => {
    const index = buildStackIndex([pr(1, "a", "b"), pr(2, "b", "a"), pr(3, "x", "a")]);
    expect(index.size).toBe(0);
  });

  it("枝分かれしても分母は一番上の段数になる", () => {
    const index = buildStackIndex([pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "a"), pr(4, "d", "b")]);
    expect([1, 2, 3, 4].map((n) => index.get(`PR_${n}`)?.position)).toEqual([1, 2, 2, 3]);
    expect(index.get("PR_4")?.height).toBe(3);
  });

  it("develop や release/* を head にした PR は親にしない", () => {
    const index = buildStackIndex([
      pr(10, "develop", "main"),
      pr(11, "feature/a", "develop"),
      pr(20, "release/1.0", "main"),
      pr(21, "hotfix", "release/1.0"),
    ]);
    expect(index.size).toBe(0);
  });

  it("デフォルトブランチを head にした PR は親にしない", () => {
    const trunk = { ...pr(10, "trunk", "release"), defaultBranchName: "trunk" };
    const index = buildStackIndex([trunk, { ...pr(11, "feature/a", "trunk"), defaultBranchName: "trunk" }]);
    expect(index.size).toBe(0);
  });

  it("同じ head ブランチの PR が 2 件あればそのブランチではつながない", () => {
    const index = buildStackIndex([pr(20, "fix", "main"), pr(21, "fix", "release-1.x"), pr(22, "y", "fix")]);
    expect(index.size).toBe(0);
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
