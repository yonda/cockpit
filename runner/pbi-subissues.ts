import type { GitHubClient } from "./github";
import { buildBranchName } from "./workflow";
import type { SubTask, SubTaskRecord } from "../lib/pbi/types";

export function subTaskBranch(issueNumber: number, title: string): string {
  return buildBranchName(issueNumber, title);
}

export async function materializeSubIssues(
  github: GitHubClient,
  repo: string,
  parent: number,
  tasks: SubTask[],
): Promise<SubTaskRecord[]> {
  const records: SubTaskRecord[] = [];
  for (const task of tasks) {
    const { number, url } = await github.createSubIssue(repo, parent, task);
    records.push({
      ...task,
      state: "pending",
      issueNumber: number,
      jobId: null,
      branch: subTaskBranch(number, task.title),
      prUrl: null,
    });
    void url; // url は現状使わない（将来のリンク表示用に残す）
  }
  return records;
}
