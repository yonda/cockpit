import type { ProgressFile, ProgressNode } from "@/lib/runs/progress";
import { fetchRunGithubState } from "./fetchers";
import type { GhIssueState, GhPullRequestState } from "./types";

/**
 * issue-driver の進捗ファイル(ライブ状態)と GitHub(確定状態)を join する層。
 * 観測契約の「1事実=1つの持ち主」に従い、マージ状態などの確定事実は
 * 進捗ファイルには持たせず、都度 GitHub から取ってここでノードに重ねる。
 */

export type JoinedNode = ProgressNode & {
  githubIssue: GhIssueState | null;
  githubPullRequest: GhPullRequestState | null;
};

export type JoinedProgressFile = Omit<ProgressFile, "nodes"> & {
  nodes: JoinedNode[];
  /** GitHub への問い合わせ自体が失敗した場合のエラー。null なら正常に取得できた(該当なしとは別) */
  githubFetchError: string | null;
};

function uniqueDefined(numbers: (number | null)[]): number[] {
  return [...new Set(numbers.filter((n): n is number => n !== null))];
}

async function joinOneFile(file: ProgressFile): Promise<JoinedProgressFile> {
  const issueNumbers = uniqueDefined(file.nodes.map((n) => n.subIssue));
  const prNumbers = uniqueDefined(file.nodes.map((n) => n.prNumber));

  try {
    const { issues, pullRequests } = await fetchRunGithubState(file.repo, issueNumbers, prNumbers);
    return {
      ...file,
      githubFetchError: null,
      nodes: file.nodes.map((node) => ({
        ...node,
        githubIssue: node.subIssue !== null ? (issues.get(node.subIssue) ?? null) : null,
        githubPullRequest: node.prNumber !== null ? (pullRequests.get(node.prNumber) ?? null) : null,
      })),
    };
  } catch (e) {
    // GitHub 側の障害・権限エラーで join できなくても、この run 以外の表示は落とさない(fail-safe)。
    return {
      ...file,
      githubFetchError: (e as Error).message,
      nodes: file.nodes.map((node) => ({ ...node, githubIssue: null, githubPullRequest: null })),
    };
  }
}

/**
 * 複数の進捗ファイルそれぞれについて、GitHub の確定状態を join する。
 * 1ファイルの取得に失敗しても他のファイルの join は継続する。
 */
export function joinProgressFilesWithGithub(files: ProgressFile[]): Promise<JoinedProgressFile[]> {
  return Promise.all(files.map(joinOneFile));
}
