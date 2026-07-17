import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { graphql, GitHubApiError } = await import("../client");

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

  it("allowPartialDataならerrorsがあってもdataを返す(部分解決)", async () => {
    mockResponse({
      data: { r0: { i70: { number: 70 }, i8859: null } },
      errors: [{ message: "Could not resolve to an Issue with the number of 8859." }],
    });

    const data = await graphql<{ r0: Record<string, unknown> }>("query {}", {
      allowPartialData: true,
    });

    expect(data.r0.i70).toEqual({ number: 70 });
    expect(data.r0.i8859).toBeNull();
  });

  it("allowPartialDataでもdataごと欠けていればthrowする(認証エラー等)", async () => {
    mockResponse({ errors: [{ message: "Bad credentials" }] });

    await expect(graphql("query {}", { allowPartialData: true })).rejects.toThrow(
      GitHubApiError,
    );
    await expect(graphql("query {}", { allowPartialData: true })).rejects.toThrow(
      /Bad credentials/,
    );
  });
});
