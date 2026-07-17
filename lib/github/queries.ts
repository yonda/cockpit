export const PULL_REQUEST_CARD_FRAGMENT = /* GraphQL */ `
  fragment PullRequestCardFields on PullRequest {
    id
    number
    title
    url
    isDraft
    createdAt
    updatedAt
    additions
    deletions
    reviewDecision
    mergeable
    repository {
      nameWithOwner
    }
    author {
      login
      avatarUrl
    }
    comments {
      totalCount
    }
    reviewThreads {
      totalCount
    }
    viewerLatestReview {
      state
    }
    reviewRequests(first: 20) {
      nodes {
        requestedReviewer {
          __typename
          ... on User {
            login
            avatarUrl
          }
          ... on Team {
            name
            slug
            avatarUrl
          }
        }
      }
    }
    latestReviews(first: 20) {
      nodes {
        state
        author {
          login
          avatarUrl
        }
      }
    }
    commits(last: 1) {
      nodes {
        commit {
          statusCheckRollup {
            state
          }
        }
      }
    }
  }
`;

export const SEARCH_PULL_REQUESTS_QUERY = /* GraphQL */ `
  query SearchPullRequests($q: String!) {
    search(query: $q, type: ISSUE, first: 50) {
      issueCount
      nodes {
        __typename
        ... on PullRequest {
          ...PullRequestCardFields
        }
      }
    }
  }
  ${PULL_REQUEST_CARD_FRAGMENT}
`;

export const VIEWER_QUERY = /* GraphQL */ `
  query Viewer {
    viewer {
      login
      avatarUrl
    }
  }
`;

export const VIEWER_STATUS_QUERY = /* GraphQL */ `
  query ViewerStatus {
    viewer {
      status {
        indicatesLimitedAvailability
        message
        expiresAt
      }
    }
  }
`;

// org: と user: の併記は OR — org 配下に加えて自分名義のリポジトリも対象にする
export function buildRepoScope(org: string): string {
  return `archived:false org:${org} user:@me`;
}

/** 1リポジトリぶんの参照番号。run のノードをリポジトリ単位にまとめたもの */
export type RunStateRefs = {
  repo: string;
  issueNumbers: number[];
  prNumbers: number[];
};

// "owner/name" ちょうど2セグメント。3セグメント("github.com/owner/name" 等)を通すと
// 先頭2つが owner/name として使われ、別リポジトリの状態を正しい情報として描いてしまう。
const REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/** repo 指定が "owner/name" 形式か */
export function isValidRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

/**
 * issue/PR 番号として使える値か。progress.ts の assertNumber は number であることしか
 * 見ないので、負数・小数がここまで来る。そのままエイリアスにすると `i-1:` のような
 * 構文的に不正な GraphQL になり、data ごと返らず run 全体が落ちる。
 */
export function isRefNumber(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/**
 * issue-driver 進捗ファイルのノードが参照する issue/PR 番号をまとめて1リクエストで取る
 * バッチクエリ。run は複数リポジトリにまたがりうる(親 issue と別 repo に sub-issue/PR を
 * 作る横断タスク)ので、リポジトリごとに repository エイリアス(r<i>)を並べ、その中を
 * 番号ごとのエイリアス(i<N>/p<N>)で分ける。
 *
 * 番号はエイリアス(i<N>/p<N>)にも使うので、GraphQL 変数にはできず文字列連結になる。
 * そのため呼び出し側で isRefNumber を通した正の整数のみを渡すこと(インジェクション対策
 * であると同時に、構文的に妥当なエイリアスを作るため)。repo も isValidRepo で検証済みの
 * ものを渡すこと。ここでの throw は不変条件の防波堤で、通常の壊れた入力は呼び出し側が
 * ノード単位で弾いて理由を利用者に見せる(run 全体を巻き添えにしないため)。
 * repo 文字列自体は進捗ファイル由来なので、クエリ本文に埋め込まず変数で渡す。
 */
export function buildRunStateQuery(refs: RunStateRefs[]): {
  query: string;
  variables: Record<string, string>;
} {
  const variables: Record<string, string> = {};
  const params: string[] = [];
  const blocks: string[] = [];

  refs.forEach((ref, i) => {
    if (!isValidRepo(ref.repo)) {
      throw new Error(`不正な repo 指定: ${JSON.stringify(ref.repo)} ("owner/name" を期待した)`);
    }
    const badNumber = [...ref.issueNumbers, ...ref.prNumbers].find((n) => !isRefNumber(n));
    if (badNumber !== undefined) {
      throw new Error(`不正な参照番号: ${badNumber}(正の整数を期待した)`);
    }
    const [owner, name] = ref.repo.split("/");
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    params.push(`$o${i}: String!`, `$n${i}: String!`);

    const fields = [
      ...ref.issueNumbers.map((n) => `i${n}: issue(number: ${n}) { number state url }`),
      ...ref.prNumbers.map(
        (n) =>
          `p${n}: pullRequest(number: ${n}) { number state isDraft mergeable reviewDecision url }`,
      ),
    ].join("\n        ");

    blocks.push(`r${i}: repository(owner: $o${i}, name: $n${i}) {
        ${fields}
      }`);
  });

  return {
    query: /* GraphQL */ `
    query RunState(${params.join(", ")}) {
      ${blocks.join("\n      ")}
    }
  `,
    variables,
  };
}

export function buildSearchQuery(
  role: "review-requested" | "author" | "reviewed-by",
  org: string,
): string {
  return `is:open is:pr ${role}:@me ${buildRepoScope(org)}`;
}
