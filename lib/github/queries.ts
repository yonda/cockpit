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

/**
 * issue-driver 進捗ファイルのノードが参照する issue/PR 番号をまとめて1リクエストで取る
 * バッチクエリ。GraphQL エイリアス(i<N>/p<N>)で番号ごとに結果を分ける。
 * 番号は progress.ts の assertNumber を通った number のみが渡る想定で、文字列連結でも
 * インジェクションの余地はない(GraphQL 変数化はエイリアスには使えないため)。
 */
export function buildRunStateQuery(issueNumbers: number[], prNumbers: number[]): string {
  const issueFields = issueNumbers
    .map((n) => `i${n}: issue(number: ${n}) { number state url }`)
    .join("\n");
  const prFields = prNumbers
    .map(
      (n) =>
        `p${n}: pullRequest(number: ${n}) { number state isDraft mergeable reviewDecision url }`,
    )
    .join("\n");
  return /* GraphQL */ `
    query RunState($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${issueFields}
        ${prFields}
      }
    }
  `;
}

export function buildSearchQuery(
  role: "review-requested" | "author" | "reviewed-by",
  org: string,
): string {
  return `is:open is:pr ${role}:@me ${buildRepoScope(org)}`;
}
