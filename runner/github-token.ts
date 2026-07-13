import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 構造ガード (Issue #54): runner とその子プロセス (spawn したエージェントの gh) は
// keyring の強い classic token (repo フルスコープ、アカウントが届く全 org に及ぶ) ではなく、
// 対象リポジトリの owner に限定した fine-grained PAT (weak token) で GitHub にアクセスする。
//
// gh CLI はトークンを GH_TOKEN > GITHUB_TOKEN > keyring の優先順で解決するため、
// ジョブ単位で resolveToken(owner) を呼び、その戻り値を GH_TOKEN として渡せば、
// runner 自身の gh 呼び出し (ポーリング・PBI 操作) と SDK が spawn するエージェントの
// gh の両方に効く。単一のグローバル GH_TOKEN を起動時に一度だけ積む方式 (旧
// applyRunnerToken) は、複数 owner のリポジトリを扱うレジストリ駆動配線 (Task 8) で
// 撤廃した。GITHUB_TOKEN は sandbox の credentials.envVars でエージェントから隠している
// (runner/sandbox-config.ts) のに対し、GH_TOKEN は「エージェントに渡すための
// 弱いトークン」なので意図的に隠さない。
//
// fail-closed: トークンファイルが無い・空の場合はそのジョブを起動しない。ここで黙って
// keyring の強いトークンに fall back すると、被害範囲の縮小という構造ガードの
// 目的が silent に無効化されるため (sandbox-config.ts の failIfUnavailable と
// 同じ思想)。

const DEFAULT_TOKEN_FILE = path.join(
  os.homedir(),
  ".config",
  "cockpit",
  "runner-token",
);

const DEFAULT_TOKENS_DIR = path.join(os.homedir(), ".config", "cockpit", "tokens");

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
  // 複数行・複数トークン (コメント行やローテーション時の書き足し等) は、fail-closed
  // チェックを通過した後に gh の認証エラーとして遠い場所で表面化するため、ここで弾く。
  if (/\s/.test(token)) {
    throw new Error(
      `runner token file にトークン以外の内容が含まれています: ${filePath} — ` +
        `PAT 1 つだけを 1 行で配置してください (Issue #54)`,
    );
  }
  return token;
}

/**
 * owner 別トークンを解決する。<tokensDir>/<owner> を読み、loadRunnerToken と同じ
 * fail-closed 検証 (欠如・空・複数行で throw) を通す。ジョブ単位で呼ぶ。
 */
export function resolveToken(
  owner: string,
  tokensDir: string = process.env.COCKPIT_TOKENS_DIR || DEFAULT_TOKENS_DIR,
): string {
  return loadRunnerToken(path.join(tokensDir, owner));
}
