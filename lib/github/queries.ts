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

export function buildSearchQuery(
  role: "review-requested" | "author" | "reviewed-by",
  org: string,
): string {
  // org: と user: の併記は OR — org 配下に加えて自分名義のリポジトリも対象にする
  return `is:open is:pr ${role}:@me archived:false org:${org} user:@me`;
}
