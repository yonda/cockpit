import { graphql } from "@/lib/github/client";
import { LAUNCH_REPO } from "@/lib/jobs/types";

export type LaunchIssue = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: Array<{ name: string; color: string }>;
};

type IssuesQuery = {
  repository: {
    issues: {
      nodes: Array<{
        number: number;
        title: string;
        url: string;
        createdAt: string;
        labels: { nodes: Array<{ name: string; color: string }> };
      }>;
    };
  } | null;
};

const QUERY = /* GraphQL */ `
  query LaunchIssues($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      issues(
        states: OPEN
        first: 50
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        nodes {
          number
          title
          url
          createdAt
          labels(first: 10) {
            nodes { name color }
          }
        }
      }
    }
  }
`;

export async function fetchOpenIssues(): Promise<LaunchIssue[]> {
  const [owner, name] = LAUNCH_REPO.split("/");
  const data = await graphql<IssuesQuery>(QUERY, {
    variables: { owner, name },
    tags: ["launch-issues"],
  });
  return (data.repository?.issues.nodes ?? []).map((n) => ({
    number: n.number,
    title: n.title,
    url: n.url,
    createdAt: n.createdAt,
    labels: n.labels.nodes,
  }));
}

const PBI_QUERY = /* GraphQL */ `
  query PbiIssues($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      issues(
        states: OPEN
        first: 50
        filterBy: { labels: ["pbi"] }
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        nodes {
          number
          title
          url
          createdAt
          labels(first: 10) { nodes { name color } }
        }
      }
    }
  }
`;

export async function fetchPbiIssues(): Promise<LaunchIssue[]> {
  const [owner, name] = LAUNCH_REPO.split("/");
  const data = await graphql<IssuesQuery>(PBI_QUERY, {
    variables: { owner, name },
    tags: ["pbi-issues"],
  });
  return (data.repository?.issues.nodes ?? []).map((n) => ({
    number: n.number,
    title: n.title,
    url: n.url,
    createdAt: n.createdAt,
    labels: n.labels.nodes,
  }));
}
