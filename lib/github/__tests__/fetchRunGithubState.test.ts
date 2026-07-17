import { beforeEach, describe, expect, it, vi } from "vitest";

const graphqlMock = vi.fn();
vi.mock("../client", () => ({
  graphql: (...args: unknown[]) => graphqlMock(...args),
}));

const { fetchRunGithubState, githubRefKey } = await import("../fetchers");

describe("fetchRunGithubState", () => {
  beforeEach(() => {
    graphqlMock.mockClear();
  });

  it("参照番号が1つも無ければGitHubに問い合わせず空の結果を返す", async () => {
    const result = await fetchRunGithubState([{ repo: "owner/name", issueNumbers: [], prNumbers: [] }]);
    expect(result.issues.size).toBe(0);
    expect(result.pullRequests.size).toBe(0);
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("エイリアス付きレスポンスをrepo付きキーのMapに変換する", async () => {
    graphqlMock.mockResolvedValueOnce({
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
    });

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
    graphqlMock.mockResolvedValueOnce({
      r0: { i70: { number: 70, state: "CLOSED", url: "https://example.invalid/a/issues/70" } },
      r1: { i70: { number: 70, state: "OPEN", url: "https://example.invalid/b/issues/70" } },
    });

    const result = await fetchRunGithubState([
      { repo: "owner/a", issueNumbers: [70], prNumbers: [] },
      { repo: "owner/b", issueNumbers: [70], prNumbers: [] },
    ]);

    expect(graphqlMock).toHaveBeenCalledTimes(1);
    // 同じ番号でも repo が違えば別物として引ける
    expect(result.issues.get(githubRefKey("owner/a", 70))?.state).toBe("CLOSED");
    expect(result.issues.get(githubRefKey("owner/b", 70))?.state).toBe("OPEN");
  });

  it("解決できなかった参照(削除済み・番号違い等)は結果のMapに含めず、他の参照は生かす", async () => {
    graphqlMock.mockResolvedValueOnce({
      r0: {
        i70: { number: 70, state: "OPEN", url: "https://example.invalid/issues/70" },
        i8859: null,
      },
    });

    const result = await fetchRunGithubState([
      { repo: "owner/name", issueNumbers: [70, 8859], prNumbers: [] },
    ]);

    expect(result.issues.has(githubRefKey("owner/name", 8859))).toBe(false);
    expect(result.issues.get(githubRefKey("owner/name", 70))?.state).toBe("OPEN");
  });

  it("部分解決を許容してGitHubに問い合わせる(1つの壊れた参照でrun全体を落とさない)", async () => {
    graphqlMock.mockResolvedValueOnce({ r0: { i70: null } });

    await fetchRunGithubState([{ repo: "owner/name", issueNumbers: [70], prNumbers: [] }]);

    expect(graphqlMock).toHaveBeenCalledWith(
      expect.stringContaining("r0: repository"),
      expect.objectContaining({ allowPartialData: true }),
    );
  });

  it("repositoryそのものがnullなら、そのrepoぶんは空のまま返す", async () => {
    graphqlMock.mockResolvedValueOnce({ r0: null });

    const result = await fetchRunGithubState([
      { repo: "owner/name", issueNumbers: [70], prNumbers: [] },
    ]);

    expect(result.issues.size).toBe(0);
  });
});
