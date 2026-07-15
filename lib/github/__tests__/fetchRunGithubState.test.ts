import { describe, expect, it, vi } from "vitest";

const graphqlMock = vi.fn();
vi.mock("../client", () => ({
  graphql: (...args: unknown[]) => graphqlMock(...args),
}));

const { fetchRunGithubState } = await import("../fetchers");

describe("fetchRunGithubState", () => {
  it("issue番号・PR番号が両方空ならGitHubに問い合わせず空の結果を返す", async () => {
    const result = await fetchRunGithubState("owner/name", [], []);
    expect(result.issues.size).toBe(0);
    expect(result.pullRequests.size).toBe(0);
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("エイリアス付きレスポンスを番号キーのMapに変換する", async () => {
    graphqlMock.mockResolvedValueOnce({
      repository: {
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

    const result = await fetchRunGithubState("owner/name", [70], [77]);

    expect(result.issues.get(70)).toEqual({
      number: 70,
      state: "OPEN",
      url: "https://example.invalid/issues/70",
    });
    expect(result.pullRequests.get(77)).toEqual({
      number: 77,
      state: "OPEN",
      isDraft: true,
      mergeable: "MERGEABLE",
      reviewDecision: null,
      url: "https://example.invalid/pull/77",
    });
  });

  it("該当ノードがnull(削除済み等)なら結果のMapに含めない", async () => {
    graphqlMock.mockResolvedValueOnce({
      repository: { i70: null },
    });

    const result = await fetchRunGithubState("owner/name", [70], []);

    expect(result.issues.has(70)).toBe(false);
  });

  it("repositoryそのものがnullなら空の結果を返す", async () => {
    graphqlMock.mockResolvedValueOnce({ repository: null });

    const result = await fetchRunGithubState("owner/name", [70], []);

    expect(result.issues.size).toBe(0);
  });
});
