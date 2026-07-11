import type { CommandRunner } from "./exec";
import { SUBTASK_MARKER, type SubTask } from "../lib/pbi/types";

export type PrState =
  | { kind: "none" }
  | { kind: "open"; url: string; reviewCommentCount: number }
  | { kind: "merged"; url: string }
  | { kind: "closed"; url: string };

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
    private readonly repoDir: string,
  ) {}

  private gh(args: string[]) {
    return this.commands.run("gh", args, { cwd: this.repoDir });
  }

  async fetchIssue(repo: string, number: number) {
    const { stdout } = await this.gh([
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
    const { stdout } = await this.gh([
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
    await this.gh([
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
    await this.gh([
      "api",
      "--method",
      "PATCH",
      `/repos/${repo}/issues/${number}`,
      "-f",
      `body=${body}`,
    ]);
  }

  async closeIssue(repo: string, number: number) {
    await this.gh(["issue", "close", String(number), "--repo", repo]);
  }

  async prStateForBranch(repo: string, branch: string): Promise<PrState> {
    const { stdout } = await this.gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "url,state,reviewThreads",
    ]);
    const prs = JSON.parse(stdout) as Array<{
      url: string;
      state: string;
      reviewThreads?: { totalCount: number };
    }>;
    if (prs.length === 0) return { kind: "none" };
    const pr = prs[0];
    if (pr.state === "MERGED") return { kind: "merged", url: pr.url };
    if (pr.state === "CLOSED") return { kind: "closed", url: pr.url };
    return {
      kind: "open",
      url: pr.url,
      reviewCommentCount: pr.reviewThreads?.totalCount ?? 0,
    };
  }
}
