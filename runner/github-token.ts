import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 構造ガード (Issue #54): runner とその子プロセス (spawn したエージェントの gh) は
// keyring の強い classic token (repo フルスコープ、Findy org まで届く) ではなく、
// yonda/cockpit に限定した fine-grained PAT (weak token) で GitHub にアクセスする。
//
// gh CLI はトークンを GH_TOKEN > GITHUB_TOKEN > keyring の優先順で解決するため、
// runner の起動時に GH_TOKEN へ weak PAT を積めば、runner 自身の gh 呼び出し
// (ポーリング・PBI 操作) と SDK が spawn するエージェントの gh の両方に効く。
// GITHUB_TOKEN は sandbox の credentials.envVars でエージェントから隠している
// (runner/sandbox-config.ts) のに対し、GH_TOKEN は「エージェントに渡すための
// 弱いトークン」なので意図的に隠さない。
//
// fail-closed: トークンファイルが無い・空の場合は起動を中止する。ここで黙って
// keyring の強いトークンに fall back すると、被害範囲の縮小という構造ガードの
// 目的が silent に無効化されるため (sandbox-config.ts の failIfUnavailable と
// 同じ思想)。

export const DEFAULT_TOKEN_FILE = path.join(
  os.homedir(),
  ".config",
  "cockpit",
  "runner-token",
);

/** トークンファイルを読み、前後空白を除いた PAT を返す。読めない・空なら throw。 */
export function loadRunnerToken(filePath: string = DEFAULT_TOKEN_FILE): string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `runner token file を読めません: ${filePath} — ` +
        `yonda/cockpit 限定の fine-grained PAT を配置してください (Issue #54)。 ` +
        `原因: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const token = raw.trim();
  if (token === "") {
    throw new Error(
      `runner token file が空です: ${filePath} — ` +
        `yonda/cockpit 限定の fine-grained PAT を配置してください (Issue #54)`,
    );
  }
  return token;
}

/**
 * weak PAT を env.GH_TOKEN に積む。runner の boot (main.ts) から一度だけ呼ぶ。
 * ファイルパスは COCKPIT_RUNNER_TOKEN_FILE で上書き可能 (テスト・開発用)。
 */
export function applyRunnerToken(env: NodeJS.ProcessEnv = process.env): void {
  const filePath = env.COCKPIT_RUNNER_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  env.GH_TOKEN = loadRunnerToken(filePath);
}
