import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 実行環境統一 (#85): runner は settings を注入しない。spawn された claude は
// 人間が普段使うユーザー settings (~/.claude/settings.json) をそのまま継承する。
// その代わり、無人実行の安全性が依存する不変条件をここで検証し、壊れていたら
// runner を起動させない — fail-closed の置き場所を「注入」から「検証」へ移した。
// 各不変条件の実測根拠は docs/permission-philosophy.md「実行環境の統一」を参照。

/** 層3 (統合操作)。エージェントの権限から構造的に外す deny ルール。 */
export const REQUIRED_DENY = [
  "Bash(gh pr merge:*)",
  "Bash(gh pr ready:*)",
  "Bash(git push --force:*)",
  "Bash(git push --force-with-lease:*)",
] as const;

/** 実質フリーパスになるため allow に置いてはならないルール。 */
export const FORBIDDEN_ALLOW = [
  "Bash(gh api:*)",
  "Bash(gh:*)",
  "Bash(git:*)",
] as const;

type SettingsShape = {
  permissions?: {
    defaultMode?: unknown;
    allow?: unknown;
    deny?: unknown;
  };
  sandbox?: {
    enabled?: unknown;
    failIfUnavailable?: unknown;
  };
};

/**
 * ユーザー settings が統一プロファイルの不変条件を満たすか検証し、
 * 違反メッセージの配列を返す (空 = 合格)。純関数。
 */
export function checkUnifiedProfile(settings: unknown): string[] {
  const violations: string[] = [];
  if (typeof settings !== "object" || settings === null) {
    return ["settings が JSON オブジェクトではありません"];
  }
  const s = settings as SettingsShape;

  // bypassPermissions は deny こそ強制されるが Seatbelt の封じ込め
  // (allowedDomains 等) を無効化することを実測済み。無人実行では不可。
  if (s.permissions?.defaultMode === "bypassPermissions") {
    violations.push(
      "permissions.defaultMode が bypassPermissions (sandbox 封じ込めが無効化される)",
    );
  }

  const deny = Array.isArray(s.permissions?.deny) ? s.permissions.deny : [];
  for (const rule of REQUIRED_DENY) {
    if (!deny.includes(rule)) {
      violations.push(`permissions.deny に ${rule} がありません (層3)`);
    }
  }

  const allow = Array.isArray(s.permissions?.allow) ? s.permissions.allow : [];
  for (const rule of FORBIDDEN_ALLOW) {
    if (allow.includes(rule)) {
      violations.push(`permissions.allow に ${rule} が含まれています (広すぎる)`);
    }
  }

  if (s.sandbox?.enabled !== true) {
    violations.push("sandbox.enabled が true ではありません (封じ込めの本丸)");
  }
  if (s.sandbox?.failIfUnavailable !== true) {
    violations.push(
      "sandbox.failIfUnavailable が true ではありません (fail-open の危険)",
    );
  }

  return violations;
}

export function defaultUserSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/**
 * ユーザー settings を読み、不変条件違反があれば throw する (runner 起動時の
 * fail-closed ゲート)。ファイル不在・JSON 破損も違反として扱う。
 */
export function assertUnifiedProfile(
  settingsPath: string = defaultUserSettingsPath(),
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    throw new Error(
      `ユーザー settings が読めません: ${settingsPath} (統一プロファイル未整備のまま runner を起動できません)`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`ユーザー settings が JSON として壊れています: ${settingsPath}`);
  }
  const violations = checkUnifiedProfile(json);
  if (violations.length > 0) {
    throw new Error(
      `ユーザー settings が統一プロファイルの不変条件を満たしません (${settingsPath}):\n- ${violations.join("\n- ")}`,
    );
  }
}
