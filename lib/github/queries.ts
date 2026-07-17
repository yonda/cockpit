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

/**
 * issue-driver 進捗ファイルのノードが参照する issue/PR 番号をまとめて1リクエストで取る
 * バッチクエリ。run は複数リポジトリにまたがりうる(親 issue と別 repo に sub-issue/PR を
 * 作る横断タスク)ので、リポジトリごとに repository エイリアス(r<i>)を並べ、その中を
 * 番号ごとのエイリアス(i<N>/p<N>)で分ける。
 *
 * 番号は progress.ts の assertNumber を通った number のみが渡る想定なので、文字列連結でも
 * インジェクションの余地はない(GraphQL 変数はエイリアスや引数名には使えないため)。
 * 一方 repo は進捗ファイル由来の任意文字列なので、クエリ本文に埋め込まず変数で渡す。
 */
export function buildRunStateQuery(refs: RunStateRefs[]): {
  query: string;
  variables: Record<string, string>;
} {
  const variables: Record<string, string> = {};
  const params: string[] = [];
  const blocks: string[] = [];

  refs.forEach((ref, i) => {
    const [owner, name] = ref.repo.split("/");
    if (!owner || !name) {
      throw new Error(`不正な repo 指定: ${JSON.stringify(ref.repo)} ("owner/name" を期待した)`);
    }
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
