import type { ProgressFile, ProgressNode } from "@/lib/runs/progress";
import { fetchRunGithubState, githubRefKey } from "./fetchers";
import type { RunStateRefs } from "./queries";
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

/** ノードの所属リポジトリ。省略時は run の repo(単一リポジトリで完結する通常の run) */
function nodeRepo(node: ProgressNode, file: ProgressFile): string {
  return node.repo ?? file.repo;
}

/** ノードをリポジトリ単位にまとめる。同じ番号を複数ノードが参照していても1回だけ問い合わせる */
function collectRefs(file: ProgressFile): RunStateRefs[] {
  const byRepo = new Map<string, { issueNumbers: Set<number>; prNumbers: Set<number> }>();

  for (const node of file.nodes) {
    const repo = nodeRepo(node, file);
    const refs = byRepo.get(repo) ?? { issueNumbers: new Set(), prNumbers: new Set() };
    if (node.subIssue !== null) refs.issueNumbers.add(node.subIssue);
    if (node.prNumber !== null) refs.prNumbers.add(node.prNumber);
    byRepo.set(repo, refs);
  }

  return [...byRepo].map(([repo, refs]) => ({
    repo,
    issueNumbers: [...refs.issueNumbers],
    prNumbers: [...refs.prNumbers],
  }));
}

async function joinOneFile(file: ProgressFile): Promise<JoinedProgressFile> {
  try {
    const { issues, pullRequests } = await fetchRunGithubState(collectRefs(file));
    return {
      ...file,
      githubFetchError: null,
      nodes: file.nodes.map((node) => {
        const repo = nodeRepo(node, file);
        return {
          ...node,
          githubIssue:
            node.subIssue !== null ? (issues.get(githubRefKey(repo, node.subIssue)) ?? null) : null,
          githubPullRequest:
            node.prNumber !== null
              ? (pullRequests.get(githubRefKey(repo, node.prNumber)) ?? null)
              : null,
        };
      }),
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
