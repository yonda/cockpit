import { env } from "@/lib/env";

// GITHUB_GRAPHQL_URL は offline 表示の検証 (到達不能ホストに向ける) や GHE 用
const GITHUB_GRAPHQL_ENDPOINT =
  process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

type GraphQLOptions = {
  variables?: Record<string, unknown>;
  revalidate?: number;
  tags?: string[];
};

export async function graphql<T>(
  query: string,
  { variables, revalidate = 0, tags = ["prs"] }: GraphQLOptions = {},
): Promise<T> {
  // revalidate = 0 は Next の fetch キャッシュを使わず毎回 GitHub に問い合わせる。
  // (revalidate > 0 は stale-while-revalidate なので、体感でポーリング 2 周分
  //  遅れることがある。リクエスト内の重複は React.cache 側で除去済み)
  const response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.githubToken}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "User-Agent": "cockpit",
    },
    body: JSON.stringify({ query, variables }),
    ...(revalidate > 0
      ? { next: { revalidate, tags } }
      : { cache: "no-store" as const }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new GitHubApiError(
      `GitHub API HTTP ${response.status}`,
      response.status,
      text,
    );
  }

  let json: { data?: T; errors?: Array<{ message: string }> };
  try {
    json = JSON.parse(text);
  } catch {
    throw new GitHubApiError("GitHub API returned invalid JSON", 500, text);
  }

  if (json.errors && json.errors.length > 0) {
    throw new GitHubApiError(
      `GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
      200,
      text,
    );
  }

  if (!json.data) {
    throw new GitHubApiError("GraphQL response missing data", 200, text);
  }

  return json.data;
}
