import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { graphql, graphqlPartial, GitHubApiError } = await import("../client");

function mockResponse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    }),
  );
}

describe("graphql", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("errorsがあればthrowする", async () => {
    mockResponse({ data: { r0: null }, errors: [{ message: "Could not resolve to an Issue" }] });

    await expect(graphql("query {}")).rejects.toThrow(/Could not resolve to an Issue/);
  });

  it("errorsが無ければdataを返す", async () => {
    mockResponse({ data: { viewer: { login: "someone" } } });

    await expect(graphql("query {}")).resolves.toEqual({ viewer: { login: "someone" } });
  });
});

describe("graphqlPartial", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("errorsがあってもdataを返し、errorsも一緒に返す(呼び出し側が見せられるように)", async () => {
    mockResponse({
      data: { r0: { i70: { number: 70 }, i8859: null } },
      errors: [{ message: "Could not resolve to an Issue with the number of 8859." }],
    });

    const { data, errors } = await graphqlPartial<{ r0: Record<string, unknown> }>("query {}");

    expect(data.r0.i70).toEqual({ number: 70 });
    expect(errors).toEqual(["Could not resolve to an Issue with the number of 8859."]);
  });

  it("全て解決できればerrorsは空", async () => {
    mockResponse({ data: { r0: { i70: { number: 70 } } } });

    const { errors } = await graphqlPartial("query {}");

    expect(errors).toEqual([]);
  });

  it("dataごと欠けていればthrowする(認証エラー等は部分解決の余地が無い)", async () => {
    mockResponse({ errors: [{ message: "Bad credentials" }] });

    await expect(graphqlPartial("query {}")).rejects.toThrow(GitHubApiError);
    await expect(graphqlPartial("query {}")).rejects.toThrow(/Bad credentials/);
  });
});
