import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 実行環境統一 (#85): runner は settings を注入しない。spawn された claude は
// 人間が普段使うユーザー settings (~/.claude/settings.json) をそのまま継承する。
// その代わり、無人実行が依存する不変条件をここで検証し、壊れていたら
// runner を起動させない — fail-closed の置き場所を「注入」から「検証」へ移した。
// 検証は 2 種類:
//   安全性 (safety): 層3 deny・sandbox 封じ込め・bypass 不使用・広すぎる allow の不在
//   完走性 (liveness): 層2 allow・acceptEdits・sandbox 内 bash の自動許可 —
//     欠けても危険ではないが、無人ジョブが誰も見ていない承認待ちで無音停止する
// 各不変条件の実測根拠は docs/permission-philosophy.md「実行環境の統一」を参照。

/** 層3 (統合操作)。エージェントの権限から構造的に外す deny ルール。
 * prefix 照合の deny は近似ガード (例: `git push origin --force` の位置違いは
 * 捕まえられない)。force push の本丸は GitHub 側のブランチ保護。 */
export const REQUIRED_DENY = [
  "Bash(gh pr merge:*)",
  "Bash(gh pr ready:*)",
  "Bash(git push --force:*)",
  "Bash(git push --force-with-lease:*)",
  "Bash(git push -f:*)",
] as const;

/** 層2 (提出) + 無人ジョブの完走に必要な allow (workflow.ts のプロンプトが指示する操作)。 */
export const REQUIRED_ALLOW = [
  "Bash(git push:*)",
  "Bash(gh pr create:*)",
  "Bash(gh issue view:*)",
  "Bash(gh issue comment:*)",
] as const;

/** sandbox 除外の gh が読める認証情報のうち、sandbox 内コマンドから隠すべきパス。 */
export const REQUIRED_CREDENTIAL_DENY_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.config/gh",
  "~/.netrc",
] as const;

/**
 * 実質フリーパスになる allow ルールか判定する。完全一致ではなく、空白ゆらぎと
 * ワイルドカード表記ゆらぎ (`:*` / ` *` / `*`) を正規化して判定する
 * (素の Bash / Bash(*) / gh / git / gh api の丸ごと許可を検出する)。
 */
export function isForbiddenAllow(rule: string): boolean {
  const norm = rule.replace(/\s+/g, " ").trim();
  if (norm === "Bash") return true;
  const m = /^Bash\((.*)\)$/.exec(norm);
  if (!m) return false;
  let inner = m[1].trim();
  if (inner === "" || inner === "*") return true;
  inner = inner.replace(/\s*:?\s*\*$/, "").trim();
  return inner === "gh" || inner === "git" || inner === "gh api";
}

type CredentialFile = { path?: unknown; mode?: unknown };

type SettingsShape = {
  permissions?: {
    defaultMode?: unknown;
    allow?: unknown;
    deny?: unknown;
  };
  sandbox?: {
    enabled?: unknown;
    failIfUnavailable?: unknown;
    autoAllowBashIfSandboxed?: unknown;
    network?: { allowedDomains?: unknown };
    credentials?: { files?: unknown };
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
  const mode = s.permissions?.defaultMode;
  if (mode === "bypassPermissions") {
    violations.push(
      "permissions.defaultMode が bypassPermissions (sandbox 封じ込めが無効化される)",
    );
  } else if (mode !== "acceptEdits") {
    violations.push(
      `permissions.defaultMode が acceptEdits ではありません (現在: ${String(mode)} — 無人ジョブが編集承認で無音停止する)`,
    );
  }

  const deny = Array.isArray(s.permissions?.deny) ? s.permissions.deny : [];
  for (const rule of REQUIRED_DENY) {
    if (!deny.includes(rule)) {
      violations.push(`permissions.deny に ${rule} がありません (層3)`);
    }
  }

  const allow = Array.isArray(s.permissions?.allow) ? s.permissions.allow : [];
  for (const rule of allow) {
    if (typeof rule === "string" && isForbiddenAllow(rule)) {
      violations.push(`permissions.allow に ${rule} が含まれています (実質フリーパス)`);
    }
  }
  for (const rule of REQUIRED_ALLOW) {
    if (!allow.includes(rule)) {
      violations.push(`permissions.allow に ${rule} がありません (層2 — 無人ジョブが提出で無音停止する)`);
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
  if (s.sandbox?.autoAllowBashIfSandboxed !== true) {
    violations.push(
      "sandbox.autoAllowBashIfSandboxed が true ではありません (層1 — sandbox 内 bash が承認待ちになる)",
    );
  }

  const domains = s.sandbox?.network?.allowedDomains;
  if (!Array.isArray(domains) || domains.length === 0) {
    violations.push(
      "sandbox.network.allowedDomains が空です (未設定 = 全ドメイン許可で封じ込めにならない)",
    );
  }

  const credFiles = s.sandbox?.credentials?.files;
  const files: CredentialFile[] = Array.isArray(credFiles) ? credFiles : [];
  for (const p of REQUIRED_CREDENTIAL_DENY_PATHS) {
    const denied = files.some((f) => f?.path === p && f?.mode === "deny");
    if (!denied) {
      violations.push(
        `sandbox.credentials.files に { path: "${p}", mode: "deny" } がありません`,
      );
    }
  }

  return violations;
}

export function defaultUserSettingsPath(): string {
  // spawn される claude が実際に読む場所に合わせる (CLAUDE_CONFIG_DIR 分離環境を考慮)。
  const base =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(base, "settings.json");
}

/**
 * ユーザー settings を読み、不変条件違反があれば throw する fail-closed ゲート。
 * runner 起動時に加えて、ジョブ spawn 毎にも呼ぶ (起動後に settings が壊された
 * 場合に次のジョブから止める — 起動時 1 回きり検証の TOCTOU 対策)。
 * ファイル不在・JSON 破損も違反として扱う。
 */
export function assertUnifiedProfile(
  settingsPath: string = defaultUserSettingsPath(),
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (err) {
    throw new Error(
      `ユーザー settings が読めません: ${settingsPath} (${String(err)}) — 統一プロファイル未整備のまま runner を起動できません`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `ユーザー settings が JSON として壊れています: ${settingsPath} (${String(err)})`,
    );
  }
  const violations = checkUnifiedProfile(json);
  if (violations.length > 0) {
    throw new Error(
      `ユーザー settings が統一プロファイルの不変条件を満たしません (${settingsPath}):\n- ${violations.join("\n- ")}`,
    );
  }
}
