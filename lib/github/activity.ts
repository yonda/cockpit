import { env } from "@/lib/env";
import { graphql } from "./client";
import { buildRepoScope } from "./queries";

export const MY_ACTIVITY_QUERY = /* GraphQL */ `
  query MyActivity($q: String!) {
    search(query: $q, type: ISSUE, first: 30) {
      nodes {
        __typename
        ... on PullRequest {
          id
          number
          title
          url
          state
          createdAt
          mergedAt
          closedAt
          repository {
            nameWithOwner
          }
          author {
            login
            avatarUrl
          }
          mergedBy {
            login
            avatarUrl
          }
          reviews(last: 20) {
            nodes {
              id
              state
              submittedAt
              body
              url
              author {
                login
                avatarUrl
              }
            }
          }
          comments(last: 20) {
            nodes {
              id
              createdAt
              body
              url
              author {
                login
                avatarUrl
              }
            }
          }
        }
      }
    }
  }
`;

type Actor = { login: string; avatarUrl: string };

type GraphQLPr = {
  __typename: "PullRequest";
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  repository: { nameWithOwner: string };
  author: Actor | null;
  mergedBy: Actor | null;
  reviews: {
    nodes: Array<{
      id: string;
      state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
      submittedAt: string | null;
      body: string;
      url: string;
      author: Actor | null;
    }>;
  };
  comments: {
    nodes: Array<{
      id: string;
      createdAt: string;
      body: string;
      url: string;
      author: Actor | null;
    }>;
  };
};

type SearchResponse = {
  search: {
    nodes: Array<GraphQLPr | { __typename: string }>;
  };
};

export type ActivitySource = "authored" | "reviewed";

export type ActivityKind = "opened" | "review" | "comment" | "merged" | "closed";

export type ActivityEvent = {
  key: string;
  kind: ActivityKind;
  reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  at: string;
  actorLogin: string;
  actorAvatarUrl: string;
  isSelf: boolean;
  body: string;
  url: string;
  pr: {
    id: string;
    number: number;
    title: string;
    url: string;
    repo: string;
    state: string;
    iAmAuthor: boolean;
    sources: ActivitySource[];
  };
};

async function fetchByRole(role: "author" | "reviewed-by"): Promise<GraphQLPr[]> {
  // 結果が first:30 を超えるため sort:updated-desc で「直近更新順の 30 件」に固定する
  // (デフォルトの best-match 順だとどの 30 件が返るか不定になる)
  const q = `is:pr ${role}:@me ${buildRepoScope(env.githubOrg)} updated:>=${daysAgoIso(30)} sort:updated-desc`;
  const data = await graphql<SearchResponse>(MY_ACTIVITY_QUERY, {
    variables: { q },
    revalidate: 60,
    tags: ["activity"],
  });
  return data.search.nodes.filter(
    (n): n is GraphQLPr => n.__typename === "PullRequest",
  );
}

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function fetchActivityEvents(viewerLogin: string): Promise<ActivityEvent[]> {
  const [authored, reviewed] = await Promise.all([
    fetchByRole("author"),
    fetchByRole("reviewed-by"),
  ]);

  const prSources = new Map<string, ActivitySource[]>();
  for (const pr of authored) prSources.set(pr.id, ["authored"]);
  for (const pr of reviewed) {
    const prev = prSources.get(pr.id) ?? [];
    prSources.set(pr.id, [...prev, "reviewed"]);
  }

  const byId = new Map<string, GraphQLPr>();
  for (const pr of [...authored, ...reviewed]) byId.set(pr.id, pr);

  const events: ActivityEvent[] = [];

  for (const pr of byId.values()) {
    const sources = prSources.get(pr.id) ?? [];
    const iAmAuthor = pr.author?.login === viewerLogin;
    const prMeta = {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      repo: pr.repository.nameWithOwner,
      state: pr.state,
      iAmAuthor,
      sources,
    };

    // opened
    if (pr.author) {
      events.push({
        key: `opened:${pr.id}`,
        kind: "opened",
        at: pr.createdAt,
        actorLogin: pr.author.login,
        actorAvatarUrl: pr.author.avatarUrl,
        isSelf: pr.author.login === viewerLogin,
        body: "",
        url: pr.url,
        pr: prMeta,
      });
    }

    // reviews
    for (const review of pr.reviews.nodes) {
      if (review.state === "PENDING") continue;
      if (!review.submittedAt) continue;
      if (!review.author) continue;
      events.push({
        key: `review:${review.id}`,
        kind: "review",
        reviewState: review.state,
        at: review.submittedAt,
        actorLogin: review.author.login,
        actorAvatarUrl: review.author.avatarUrl,
        isSelf: review.author.login === viewerLogin,
        body: review.body,
        url: review.url,
        pr: prMeta,
      });
    }

    // comments
    for (const comment of pr.comments.nodes) {
      if (!comment.author) continue;
      events.push({
        key: `comment:${comment.id}`,
        kind: "comment",
        at: comment.createdAt,
        actorLogin: comment.author.login,
        actorAvatarUrl: comment.author.avatarUrl,
        isSelf: comment.author.login === viewerLogin,
        body: comment.body,
        url: comment.url,
        pr: prMeta,
      });
    }

    // merged
    if (pr.mergedAt) {
      const actor = pr.mergedBy ?? pr.author;
      events.push({
        key: `merged:${pr.id}`,
        kind: "merged",
        at: pr.mergedAt,
        actorLogin: actor?.login ?? "unknown",
        actorAvatarUrl: actor?.avatarUrl ?? "",
        isSelf: actor?.login === viewerLogin,
        body: "",
        url: pr.url,
        pr: prMeta,
      });
    }

    // closed (not merged)
    if (pr.closedAt && !pr.mergedAt) {
      // GitHub search doesn't expose closedBy in default fields; use author as
      // fallback actor since we don't fetch timelineItems yet
      const actor = pr.author;
      events.push({
        key: `closed:${pr.id}`,
        kind: "closed",
        at: pr.closedAt,
        actorLogin: actor?.login ?? "unknown",
        actorAvatarUrl: actor?.avatarUrl ?? "",
        isSelf: actor?.login === viewerLogin,
        body: "",
        url: pr.url,
        pr: prMeta,
      });
    }
  }

  events.sort((a, b) => b.at.localeCompare(a.at));
  return events;
}

export type ActivityRange = "today" | "yesterday" | "7d" | "30d";

export function parseRange(value: string | undefined): ActivityRange {
  if (value === "yesterday" || value === "7d" || value === "30d") return value;
  return "today";
}

export function rangeCutoffIso(range: ActivityRange): { fromIso: string; toIso?: string } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "today") {
    return { fromIso: startOfToday.toISOString() };
  }
  if (range === "yesterday") {
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    return {
      fromIso: startOfYesterday.toISOString(),
      toIso: startOfToday.toISOString(),
    };
  }
  const days = range === "7d" ? 7 : 30;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString() };
}

export function filterByRange<T extends { at: string }>(
  events: T[],
  range: ActivityRange,
): T[] {
  const { fromIso, toIso } = rangeCutoffIso(range);
  return events.filter((e) => {
    if (e.at < fromIso) return false;
    if (toIso && e.at >= toIso) return false;
    return true;
  });
}
