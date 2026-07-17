import { describe, expect, it } from "vitest";
import { buildRunStateQuery, isRefNumber, isValidRepo } from "../queries";

describe("buildRunStateQuery", () => {
  it("issue番号とPR番号をそれぞれエイリアス付きフィールドにする", () => {
    const { query, variables } = buildRunStateQuery([
      { repo: "owner/name", issueNumbers: [70, 71], prNumbers: [77] },
    ]);

    expect(query).toContain("i70: issue(number: 70)");
    expect(query).toContain("i71: issue(number: 71)");
    expect(query).toContain("p77: pullRequest(number: 77)");
    expect(query).toContain("r0: repository(owner: $o0, name: $n0)");
    expect(query).toContain("$o0: String!");
    expect(query).toContain("$n0: String!");
    expect(variables).toEqual({ o0: "owner", n0: "name" });
  });

  it("issue番号のみ・PR番号のみでもフィールドを生成する", () => {
    const issuesOnly = buildRunStateQuery([{ repo: "owner/name", issueNumbers: [70], prNumbers: [] }]);
    expect(issuesOnly.query).toContain("i70: issue");
    expect(issuesOnly.query).not.toContain("pullRequest");

    const prsOnly = buildRunStateQuery([{ repo: "owner/name", issueNumbers: [], prNumbers: [77] }]);
    expect(prsOnly.query).toContain("p77: pullRequest");
    expect(prsOnly.query).not.toContain(": issue(");
  });

  it("複数リポジトリをrepositoryエイリアスで並べ、repoは変数で渡す", () => {
    const { query, variables } = buildRunStateQuery([
      { repo: "owner/a", issueNumbers: [70], prNumbers: [] },
      { repo: "owner/b", issueNumbers: [8859], prNumbers: [8862] },
    ]);

    expect(query).toContain("r0: repository(owner: $o0, name: $n0)");
    expect(query).toContain("r1: repository(owner: $o1, name: $n1)");
    expect(query).toContain("i8859: issue(number: 8859)");
    expect(query).toContain("p8862: pullRequest(number: 8862)");
    // repo 文字列はクエリ本文に埋め込まない(変数で渡す)
    expect(query).not.toContain("owner/b");
    expect(variables).toEqual({ o0: "owner", n0: "a", o1: "owner", n1: "b" });
  });

  // ここでの throw は不変条件の防波堤。壊れた入力は呼び出し側(collectRefs)がノード単位で弾く。
  it.each([
    ["owner が無い", "name-only"],
    ["セグメントが多い(URL の貼り間違い等)", "github.com/owner/name"],
    ["空セグメント", "owner/"],
  ])('repoが"owner/name"形式でなければthrowする: %s', (_label, repo) => {
    expect(() => buildRunStateQuery([{ repo, issueNumbers: [70], prNumbers: [] }])).toThrow(
      /不正な repo 指定/,
    );
  });

  it.each([
    ["負数", -1],
    ["小数", 1.5],
    ["ゼロ", 0],
  ])("参照番号が正の整数でなければthrowする(不正なエイリアスを作らない): %s", (_label, n) => {
    expect(() => buildRunStateQuery([{ repo: "owner/name", issueNumbers: [n], prNumbers: [] }])).toThrow(
      /不正な参照番号/,
    );
  });
});

describe("isValidRepo", () => {
  it.each([
    ["owner/name", true],
    ["name-only", false],
    ["github.com/owner/name", false],
    ["owner/", false],
    ["/name", false],
    ["owner name", false],
  ])("%s -> %s", (repo, expected) => {
    expect(isValidRepo(repo)).toBe(expected);
  });
});

describe("isRefNumber", () => {
  it.each([
    [70, true],
    [0, false],
    [-1, false],
    [1.5, false],
    [Number.NaN, false],
  ])("%s -> %s", (n, expected) => {
    expect(isRefNumber(n)).toBe(expected);
  });
});
