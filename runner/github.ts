import type { CommandRunner } from "./exec";
import { SUBTASK_MARKER, type SubTask } from "../lib/pbi/types";
import type { AssignedIssue } from "../lib/repos/types";

export type PrState =
  | { kind: "none" }
  | {
      kind: "open";
      url: string;
      reviewCommentCount: number;
      /**
       * OPEN な PR の「最新レビューコメント」の識別子 (createdAt / ISO 8601)。
       * 件数だけでは新旧を判別できないため、無限ループ防止マーカー判定の材料として公開する。
       * コメントが無い / 取得失敗時は null。
       */
      latestReviewCommentAt: string | null;
    }
  | { kind: "merged"; url: string }
  | { kind: "closed"; url: string };

// AssignedIssue はソケットプロトコルの一部なので lib 側で定義し、ここから再輸出する。
export type { AssignedIssue } from "../lib/repos/types";

export interface GitHubClient {
  fetchIssue(repo: string, number: number): Promise<{ title: string; body: string }>;
  createSubIssue(
    repo: string,
    parent: number,
    task: SubTask,
  ): Promise<{ number: number; url: string }>;
  updateIssueBody(repo: string, number: number, body: string): Promise<void>;
  closeIssue(repo: string, number: number): Promise<void>;
  prStateForBranch(repo: string, branch: string): Promise<PrState>;
  /**
   * owner のアイデンティティ (owner 別 fine-grained token) で
   * assignee:@me is:open is:issue を検索する検索プリミティブ。
   * ラベル絞り込みは行わない。
   */
  searchAssignedOpenIssues(owner: string): Promise<AssignedIssue[]>;
}

export function subIssueBody(task: SubTask, proposed: boolean): string {
  const lines: string[] = [];
  if (proposed) lines.push(SUBTASK_MARKER, "");
  lines.push(
    `**目的**: ${task.goal}`,
    "",
    `**成果物**: ${task.deliverable}`,
    "",
    "**受け入れ基準**:",
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
  );
  if (task.dependsOn.length > 0) {
    lines.push("", `**依存**: ${task.dependsOn.join(", ")}`);
  }
  return lines.join("\n");
}

export class RealGitHubClient implements GitHubClient {
  constructor(
    private readonly commands: CommandRunner,
    private readonly resolveToken: (owner: string) => string,
  ) {}

  private gh(repo: string, args: string[]) {
    return this.ghAsOwner(repo.split("/")[0], args);
  }

  /** owner のトークンを解決して gh を実行する (resolveToken の throw はそのまま伝播)。 */
  private ghAsOwner(owner: string, args: string[]) {
    return this.commands.run("gh", args, {
      cwd: process.cwd(),
      env: { GH_TOKEN: this.resolveToken(owner) },
    });
  }

  async fetchIssue(repo: string, number: number) {
    const { stdout } = await this.gh(repo, [
      "issue",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "title,body",
    ]);
    const issue = JSON.parse(stdout) as { title: string; body: string };
    return { title: issue.title, body: issue.body ?? "" };
  }

  async createSubIssue(repo: string, parent: number, task: SubTask) {
    // 1) 子 Issue を作成（返り値に内部 id と number を含む REST を使う）
    const { stdout } = await this.gh(repo, [
      "api",
      "--method",
      "POST",
      `/repos/${repo}/issues`,
      "-f",
      `title=${task.title}`,
      "-f",
      `body=${subIssueBody(task, true)}`,
    ]);
    const created = JSON.parse(stdout) as {
      id: number;
      number: number;
      html_url: string;
    };
    // 2) 親にリンク（body の sub_issue_id は number ではなく内部 id）
    await this.gh(repo, [
      "api",
      "--method",
      "POST",
      `/repos/${repo}/issues/${parent}/sub_issues`,
      "-F",
      `sub_issue_id=${created.id}`,
    ]);
    return { number: created.number, url: created.html_url };
  }

  async updateIssueBody(repo: string, number: number, body: string) {
    await this.gh(repo, [
      "api",
      "--method",
      "PATCH",
      `/repos/${repo}/issues/${number}`,
      "-f",
      `body=${body}`,
    ]);
  }

  async closeIssue(repo: string, number: number) {
    await this.gh(repo, ["issue", "close", String(number), "--repo", repo]);
  }

  async searchAssignedOpenIssues(owner: string): Promise<AssignedIssue[]> {
    const { stdout } = await this.ghAsOwner(owner, [
      "search",
      "issues",
      "--assignee",
      "@me",
      "--state",
      "open",
      "--owner",
      owner,
      "--json",
      "number,title,url,createdAt,labels,repository",
    ]);
    const rows = JSON.parse(stdout) as Array<{
      number: number;
      title: string;
      url: string;
      createdAt: string;
      labels?: Array<{ name: string }>;
      repository?: { nameWithOwner: string };
    }>;
    return rows.map((row) => ({
      repo: row.repository?.nameWithOwner ?? "",
      issueNumber: row.number,
      title: row.title,
      url: row.url,
      createdAt: row.createdAt,
      labels: (row.labels ?? []).map((label) => label.name),
    }));
  }

  async prStateForBranch(repo: string, branch: string): Promise<PrState> {
    // reviewThreads は `gh pr list`/`gh pr view` の JSON フィールドに存在しない
    // (GraphQL 概念)。list では state/url/number だけ取り、レビュースレッド数は
    // OPEN のときだけ graphql で別途取得する。
    const { stdout } = await this.gh(repo, [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "url,state,number",
    ]);
    const prs = JSON.parse(stdout) as Array<{
      url: string;
      state: string;
      number: number;
    }>;
    if (prs.length === 0) return { kind: "none" };
    const pr = prs[0];
    if (pr.state === "MERGED") return { kind: "merged", url: pr.url };
    if (pr.state === "CLOSED") return { kind: "closed", url: pr.url };
    return {
      kind: "open",
      url: pr.url,
      reviewCommentCount: await this.reviewThreadCount(repo, pr.number),
      latestReviewCommentAt: await this.latestReviewCommentAt(repo, pr.number),
    };
  }

  /** OPEN な PR のレビュースレッド数を GraphQL で取得する (失敗時は 0)。 */
  private async reviewThreadCount(repo: string, number: number): Promise<number> {
    const [owner, name] = repo.split("/");
    try {
      const { stdout } = await this.gh(repo, [
        "api",
        "graphql",
        "-f",
        `query=query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${number}){reviewThreads{totalCount}}}}`,
      ]);
      const parsed = JSON.parse(stdout) as {
        data?: {
          repository?: {
            pullRequest?: { reviewThreads?: { totalCount?: number } };
          };
        };
      };
      return (
        parsed.data?.repository?.pullRequest?.reviewThreads?.totalCount ?? 0
      );
    } catch {
      return 0;
    }
  }

  /**
   * OPEN な PR の「最新レビューコメント」の createdAt を GraphQL で取得する。
   * reviewThreadCount と同じ GraphQL 経路 (reviewThreads) を辿り、各スレッド末尾
   * コメントの createdAt を集めて最大値 (= 最新) を返す。ISO 8601 (UTC/末尾 Z)
   * なので辞書順比較で新旧を判別できる。コメントが無い / 取得失敗時は null。
   */
  private async latestReviewCommentAt(
    repo: string,
    number: number,
  ): Promise<string | null> {
    const [owner, name] = repo.split("/");
    try {
      const { stdout } = await this.gh(repo, [
        "api",
        "graphql",
        "-f",
        `query=query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${number}){reviewThreads(first:100){nodes{comments(last:1){nodes{createdAt}}}}}}}`,
      ]);
      const parsed = JSON.parse(stdout) as {
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: Array<{
                  comments?: { nodes?: Array<{ createdAt?: string }> };
                }>;
              };
            };
          };
        };
      };
      const nodes =
        parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      const timestamps = nodes
        .flatMap((thread) => thread.comments?.nodes ?? [])
        .map((comment) => comment.createdAt)
        .filter((at): at is string => typeof at === "string");
      if (timestamps.length === 0) return null;
      return timestamps.reduce((latest, at) => (at > latest ? at : latest));
    } catch {
      return null;
    }
  }
}
