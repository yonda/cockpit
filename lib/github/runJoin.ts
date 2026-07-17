import type { ProgressFile, ProgressNode } from "@/lib/runs/progress";
import { fetchRunGithubState, githubRefKey } from "./fetchers";
import { isRefNumber, isValidRepo, type RunStateRefs } from "./queries";
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
  /**
   * 一部の参照だけ GitHub 状態を取れなかった理由(空なら全て解決できた)。
   * run 全体は表示できるが、ここに理由が入っているノードは「状態が無い」のではなく
   * 「取れなかった」。両者は UI 上で見分けられなければならない。
   */
  githubPartialErrors: string[];
};

/** ノードの所属リポジトリ。省略時は run の repo(単一リポジトリで完結する通常の run) */
function nodeRepo(node: ProgressNode, file: ProgressFile): string {
  return node.repo ?? file.repo;
}

type CollectedRefs = {
  refs: RunStateRefs[];
  /** 問い合わせる前に弾いたノードの理由 */
  invalid: string[];
};

/**
 * ノードをリポジトリ単位にまとめる。同じ番号を複数ノードが参照していても1回だけ問い合わせる。
 * 進捗ファイルは外部(issue-driver)が書くので、repo や番号が壊れていることがある。
 * 壊れたノードはここで弾いて理由を返し、正常なノードの問い合わせは続ける
 * (1ノードの書き間違いで run 全体の GitHub 状態を失わないため)。
 */
function collectRefs(file: ProgressFile): CollectedRefs {
  const byRepo = new Map<string, { issueNumbers: Set<number>; prNumbers: Set<number> }>();
  const invalid: string[] = [];

  for (const node of file.nodes) {
    const repo = nodeRepo(node, file);
    if (!isValidRepo(repo)) {
      invalid.push(`${node.key}: 不正な repo ${JSON.stringify(repo)}("owner/name" を期待した)`);
      continue;
    }

    const refs = byRepo.get(repo) ?? { issueNumbers: new Set(), prNumbers: new Set() };
    if (node.subIssue !== null) {
      if (isRefNumber(node.subIssue)) refs.issueNumbers.add(node.subIssue);
      else invalid.push(`${node.key}: 不正な subIssue ${node.subIssue}(正の整数を期待した)`);
    }
    if (node.prNumber !== null) {
      if (isRefNumber(node.prNumber)) refs.prNumbers.add(node.prNumber);
      else invalid.push(`${node.key}: 不正な prNumber ${node.prNumber}(正の整数を期待した)`);
    }
    byRepo.set(repo, refs);
  }

  return {
    refs: [...byRepo].map(([repo, refs]) => ({
      repo,
      issueNumbers: [...refs.issueNumbers],
      prNumbers: [...refs.prNumbers],
    })),
    invalid,
  };
}

async function joinOneFile(file: ProgressFile): Promise<JoinedProgressFile> {
  const { refs, invalid } = collectRefs(file);
  try {
    const { issues, pullRequests, errors } = await fetchRunGithubState(refs);
    return {
      ...file,
      githubFetchError: null,
      githubPartialErrors: [...invalid, ...errors],
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
      githubPartialErrors: invalid,
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
