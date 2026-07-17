import { beforeEach, describe, expect, it, vi } from "vitest";

const graphqlPartialMock = vi.fn();
vi.mock("../client", () => ({
  graphql: vi.fn(),
  graphqlPartial: (...args: unknown[]) => graphqlPartialMock(...args),
}));

const { fetchRunGithubState, githubRefKey } = await import("../fetchers");

describe("fetchRunGithubState", () => {
  beforeEach(() => {
    graphqlPartialMock.mockClear();
  });

  it("参照番号が1つも無ければGitHubに問い合わせず空の結果を返す", async () => {
    const result = await fetchRunGithubState([{ repo: "owner/name", issueNumbers: [], prNumbers: [] }]);
    expect(result.issues.size).toBe(0);
    expect(result.pullRequests.size).toBe(0);
    expect(graphqlPartialMock).not.toHaveBeenCalled();
  });

  it("エイリアス付きレスポンスをrepo付きキーのMapに変換する", async () => {
    graphqlPartialMock.mockResolvedValueOnce({ data: {
      r0: {
        i70: { number: 70, state: "OPEN", url: "https://example.invalid/issues/70" },
        p77: {
          number: 77,
          state: "OPEN",
          isDraft: true,
          mergeable: "MERGEABLE",
          reviewDecision: null,
          url: "https://example.invalid/pull/77",
        },
      },
    }, errors: [] });

    const result = await fetchRunGithubState([
      { repo: "owner/name", issueNumbers: [70], prNumbers: [77] },
    ]);

    expect(result.issues.get(githubRefKey("owner/name", 70))).toEqual({
      number: 70,
      state: "OPEN",
      url: "https://example.invalid/issues/70",
    });
    expect(result.pullRequests.get(githubRefKey("owner/name", 77))).toEqual({
      number: 77,
      state: "OPEN",
      isDraft: true,
      mergeable: "MERGEABLE",
      reviewDecision: null,
      url: "https://example.invalid/pull/77",
    });
  });

  it("複数リポジトリの参照を1リクエストで取得し、repoごとに引ける", async () => {
    graphqlPartialMock.mockResolvedValueOnce({ data: {
      r0: { i70: { number: 70, state: "CLOSED", url: "https://example.invalid/a/issues/70" } },
      r1: { i70: { number: 70, state: "OPEN", url: "https://example.invalid/b/issues/70" } },
    }, errors: [] });

    const result = await fetchRunGithubState([
      { repo: "owner/a", issueNumbers: [70], prNumbers: [] },
      { repo: "owner/b", issueNumbers: [70], prNumbers: [] },
    ]);

    expect(graphqlPartialMock).toHaveBeenCalledTimes(1);
    // 同じ番号でも repo が違えば別物として引ける
    expect(result.issues.get(githubRefKey("owner/a", 70))?.state).toBe("CLOSED");
    expect(result.issues.get(githubRefKey("owner/b", 70))?.state).toBe("OPEN");
  });

  it("解決できなかった参照(削除済み・番号違い等)は結果のMapに含めず、他の参照は生かす", async () => {
    graphqlPartialMock.mockResolvedValueOnce({ data: {
      r0: {
        i70: { number: 70, state: "OPEN", url: "https://example.invalid/issues/70" },
        i8859: null,
      },
    }, errors: [] });

    const result = await fetchRunGithubState([
      { repo: "owner/name", issueNumbers: [70, 8859], prNumbers: [] },
    ]);

    expect(result.issues.has(githubRefKey("owner/name", 8859))).toBe(false);
    expect(result.issues.get(githubRefKey("owner/name", 70))?.state).toBe("OPEN");
  });

  it("GitHubが返したerrorsを握り潰さず呼び出し側へ返す(取れなかったのか元から無いのかを区別させる)", async () => {
    graphqlPartialMock.mockResolvedValueOnce({
      data: { r0: { i70: { number: 70, state: "OPEN", url: "u1" } }, r1: null },
      errors: ["Could not resolve to a Repository with the name 'owner/private'."],
    });

    const result = await fetchRunGithubState([
      { repo: "owner/name", issueNumbers: [70], prNumbers: [] },
      { repo: "owner/private", issueNumbers: [1], prNumbers: [] },
    ]);

    expect(result.errors).toEqual([
      "Could not resolve to a Repository with the name 'owner/private'.",
    ]);
    // 取れた側は生きている
    expect(result.issues.get(githubRefKey("owner/name", 70))?.state).toBe("OPEN");
  });

  it("全て解決できればerrorsは空", async () => {
    graphqlPartialMock.mockResolvedValueOnce({
      data: { r0: { i70: { number: 70, state: "OPEN", url: "u1" } } },
      errors: [],
    });

    const result = await fetchRunGithubState([
      { repo: "owner/name", issueNumbers: [70], prNumbers: [] },
    ]);

    expect(result.errors).toEqual([]);
  });

  it("repositoryそのものがnullなら、そのrepoぶんは空のまま返す", async () => {
    graphqlPartialMock.mockResolvedValueOnce({ data: { r0: null }, errors: [] });

    const result = await fetchRunGithubState([
      { repo: "owner/name", issueNumbers: [70], prNumbers: [] },
    ]);

    expect(result.issues.size).toBe(0);
  });
});
