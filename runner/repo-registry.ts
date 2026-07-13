import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type RepoConfig = {
  repo: string;
  path: string;
  baseBranch: string;
  tokenOwner: string;
};

const DEFAULT_REPOS_FILE = path.join(
  os.homedir(),
  ".config",
  "cockpit",
  "repos.json",
);

// エントリが有効か: 必須フィールドが非空文字列で、path が実在するディレクトリ。
function isValid(entry: unknown): entry is RepoConfig {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  for (const k of ["repo", "path", "baseBranch", "tokenOwner"]) {
    if (typeof e[k] !== "string" || (e[k] as string).length === 0) return false;
  }
  try {
    return fs.statSync(e.path as string).isDirectory();
  } catch {
    return false;
  }
}

export class RepoRegistry {
  private readonly byRepo = new Map<string, RepoConfig>();
  constructor(configs: RepoConfig[]) {
    for (const c of configs) this.byRepo.set(c.repo, c);
  }
  resolve(repo: string): RepoConfig | null {
    return this.byRepo.get(repo) ?? null;
  }
  all(): RepoConfig[] {
    return [...this.byRepo.values()];
  }
}

// repos.json を読む。読めない・壊れている・不正エントリは握りつぶして (ログ)、
// 有効なエントリだけのレジストリを返す。デーモン全体は落とさない
// (未登録リポジトリの job.fire は呼び出し側が fail-closed で失敗させる)。
export function loadRegistry(
  file: string = process.env.COCKPIT_REPOS_FILE || DEFAULT_REPOS_FILE,
): RepoRegistry {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return new RepoRegistry([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[runner] repos.json のパースに失敗: ${file}`);
    return new RepoRegistry([]);
  }
  const repos = (parsed as { repos?: unknown }).repos;
  if (!Array.isArray(repos)) return new RepoRegistry([]);
  const valid: RepoConfig[] = [];
  for (const entry of repos) {
    if (isValid(entry)) {
      valid.push(entry);
    } else {
      console.error(`[runner] repos.json の無効なエントリを無視: ${JSON.stringify(entry)}`);
    }
  }
  return new RepoRegistry(valid);
}
