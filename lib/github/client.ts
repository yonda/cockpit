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

/** data と errors を両方持つ生の結果。errors があっても data が返ることがある(部分解決) */
export type GraphQLResult<T> = {
  data: T;
  /** 解決できなかったフィールドの理由。空配列なら全て解決できた */
  errors: string[];
};

async function request<T>(
  query: string,
  { variables, revalidate = 0, tags = ["prs"] }: GraphQLOptions = {},
): Promise<GraphQLResult<T>> {
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

  const errors = (json.errors ?? []).map((e) => e.message);

  // data ごと欠けている(認証エラー・クエリのパースエラー等)なら、部分解決の余地は無い。
  if (!json.data) {
    throw new GitHubApiError(
      errors.length > 0 ? `GraphQL errors: ${errors.join(", ")}` : "GraphQL response missing data",
      200,
      text,
    );
  }

  return { data: json.data, errors };
}

/**
 * errors があれば throw する通常の問い合わせ。
 * 「一部が解決できなくても残りを使いたい」場合のみ graphqlPartial を使う。
 */
export async function graphql<T>(query: string, options: GraphQLOptions = {}): Promise<T> {
  const { data, errors } = await request<T>(query, options);
  if (errors.length > 0) {
    throw new GitHubApiError(`GraphQL errors: ${errors.join(", ")}`, 200, JSON.stringify(errors));
  }
  return data;
}

/**
 * data と errors を両方返す問い合わせ。GraphQL は解決できなかった nullable フィールドだけを
 * null にして残りの data を返すので、バッチクエリで「1つの壊れた参照が全体を巻き添えにする」
 * のを避けたい呼び出し側が使う。
 *
 * errors を握り潰さないこと: 呼び出し側は返った errors を必ず利用者に見せる。
 * 見せずに捨てると、権限エラーで取れなかったのか元から存在しないのかが区別できなくなる。
 */
export function graphqlPartial<T>(
  query: string,
  options: GraphQLOptions = {},
): Promise<GraphQLResult<T>> {
  return request<T>(query, options);
}
