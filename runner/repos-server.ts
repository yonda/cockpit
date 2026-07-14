// runner/repos-server.ts
import type {
  AssignedIssuesResult,
  ReposRunnerRequest,
} from "../lib/repos/types";
import type { GitHubClient } from "./github";
import type { RepoRegistry } from "./repo-registry";

export type ReposServerDeps = {
  registry: RepoRegistry;
  github: GitHubClient;
};

/**
 * 登録リポ (repos.json) に限定した「自分アサインの open issue」一覧を返す。
 * 登録リポを owner でグルーピングし、owner 別トークンの検索プリミティブ
 * (searchAssignedOpenIssues) を owner ごとに実行、結果を登録リポ集合に
 * intersect してマージする。ある owner の検索が失敗しても RPC 全体は成功の
 * まま、その owner を errors に印として載せる (fail-safe。デーモンは落とさない)。
 */
export async function listAssignedIssues(
  deps: ReposServerDeps,
): Promise<AssignedIssuesResult> {
  const registered = new Set(deps.registry.all().map((c) => c.repo));
  const owners = [
    ...new Set([...registered].map((repo) => repo.split("/")[0])),
  ];
  const result: AssignedIssuesResult = { issues: [], errors: [] };
  for (const owner of owners) {
    try {
      const found = await deps.github.searchAssignedOpenIssues(owner);
      result.issues.push(...found.filter((issue) => registered.has(issue.repo)));
    } catch (err) {
      result.errors.push({
        owner,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export async function handleReposRequest(
  request: ReposRunnerRequest,
  deps: ReposServerDeps,
): Promise<{ result?: unknown; error?: { message: string } }> {
  switch (request.method) {
    case "repos.assignedIssues":
      return { result: await listAssignedIssues(deps) };

    default:
      return { error: { message: "unknown repos method" } };
  }
}
