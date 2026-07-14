import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertUnifiedProfile,
  checkUnifiedProfile,
  isForbiddenAllow,
  REQUIRED_ALLOW,
  REQUIRED_CREDENTIAL_DENY_PATHS,
  REQUIRED_DENY,
} from "../profile-check";

// 実行環境統一 (#85): runner は settings を注入せず、ユーザー settings の
// 不変条件を起動時 + spawn 毎に検証する (fail-closed)。ここではその判定を固定する。
// 不変条件の実測根拠は docs/permission-philosophy.md「実行環境の統一」。

function validSettings() {
  return {
    permissions: {
      defaultMode: "acceptEdits",
      allow: ["Bash(pnpm:*)", ...REQUIRED_ALLOW],
      deny: ["Bash(sudo *)", ...REQUIRED_DENY],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ["github.com"] },
      credentials: {
        files: REQUIRED_CREDENTIAL_DENY_PATHS.map((p) => ({
          path: p,
          mode: "deny",
        })),
      },
    },
  };
}

describe("isForbiddenAllow", () => {
  it("実質フリーパスのルールを表記ゆらぎ込みで検出する", () => {
    for (const rule of [
      "Bash",
      "Bash(*)",
      "Bash(gh api:*)",
      "Bash(gh api :*)",
      "Bash(gh:*)",
      "Bash(gh *)",
      "Bash(git:*)",
      "Bash(git *)",
    ]) {
      expect(isForbiddenAllow(rule), rule).toBe(true);
    }
  });

  it("限定されたルールは許容する", () => {
    for (const rule of [
      "Bash(git push:*)",
      "Bash(gh pr create:*)",
      "Bash(gh pr view:*)",
      "Bash(pnpm:*)",
      "WebFetch",
    ]) {
      expect(isForbiddenAllow(rule), rule).toBe(false);
    }
  });
});

describe("checkUnifiedProfile", () => {
  it("統一プロファイルの条件を満たす settings は違反ゼロ", () => {
    expect(checkUnifiedProfile(validSettings())).toEqual([]);
  });

  it("bypassPermissions は違反 (実測: Seatbelt 封じ込めを無効化する)", () => {
    const s = validSettings();
    s.permissions.defaultMode = "bypassPermissions";
    expect(checkUnifiedProfile(s).join()).toContain("bypassPermissions");
  });

  it("acceptEdits 以外の defaultMode は完走性違反", () => {
    const s = validSettings();
    s.permissions.defaultMode = "default";
    expect(checkUnifiedProfile(s).join()).toContain("acceptEdits");
  });

  it("層3 deny の欠落を 1 件ずつ検出する", () => {
    for (const rule of REQUIRED_DENY) {
      const s = validSettings();
      s.permissions.deny = s.permissions.deny.filter((r) => r !== rule);
      expect(checkUnifiedProfile(s).join()).toContain(rule);
    }
  });

  it("層2 allow の欠落を 1 件ずつ検出する (完走性)", () => {
    for (const rule of REQUIRED_ALLOW) {
      const s = validSettings();
      s.permissions.allow = s.permissions.allow.filter((r) => r !== rule);
      expect(checkUnifiedProfile(s).join()).toContain(rule);
    }
  });

  it("広すぎる allow を拒否する", () => {
    const s = validSettings();
    s.permissions.allow.push("Bash(gh api:*)");
    expect(checkUnifiedProfile(s).join()).toContain("Bash(gh api:*)");
  });

  it("sandbox 無効 / fail-open / auto-allow なしは違反", () => {
    const noSandbox = validSettings();
    noSandbox.sandbox.enabled = false;
    expect(checkUnifiedProfile(noSandbox).join()).toContain("sandbox.enabled");

    const failOpen = validSettings();
    failOpen.sandbox.failIfUnavailable = false;
    expect(checkUnifiedProfile(failOpen).join()).toContain("failIfUnavailable");

    const noAuto = validSettings();
    noAuto.sandbox.autoAllowBashIfSandboxed = false;
    expect(checkUnifiedProfile(noAuto).join()).toContain(
      "autoAllowBashIfSandboxed",
    );
  });

  it("network.allowedDomains が空/未設定は違反 (全ドメイン許可は封じ込めではない)", () => {
    const s = validSettings();
    s.sandbox.network.allowedDomains = [];
    expect(checkUnifiedProfile(s).join()).toContain("allowedDomains");

    const missing = validSettings() as Record<string, never> &
      ReturnType<typeof validSettings>;
    delete (missing.sandbox as { network?: unknown }).network;
    expect(checkUnifiedProfile(missing).join()).toContain("allowedDomains");
  });

  it("credentials deny の欠落をパスごとに検出する", () => {
    for (const p of REQUIRED_CREDENTIAL_DENY_PATHS) {
      const s = validSettings();
      s.sandbox.credentials.files = s.sandbox.credentials.files.filter(
        (f) => f.path !== p,
      );
      expect(checkUnifiedProfile(s).join()).toContain(p);
    }
  });

  it("オブジェクトでない settings は違反", () => {
    expect(checkUnifiedProfile(null).length).toBeGreaterThan(0);
    expect(checkUnifiedProfile("{}").length).toBeGreaterThan(0);
  });

  it("permissions / sandbox 欠落でも throw せず違反として列挙する", () => {
    expect(checkUnifiedProfile({}).length).toBeGreaterThan(0);
  });
});

describe("assertUnifiedProfile", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
    file = path.join(dir, "settings.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("合格する settings では throw しない", () => {
    fs.writeFileSync(file, JSON.stringify(validSettings()));
    expect(() => assertUnifiedProfile(file)).not.toThrow();
  });

  it("ファイル不在は fail-closed (throw、原因を含む)", () => {
    expect(() => assertUnifiedProfile(path.join(dir, "nope.json"))).toThrow(
      /読めません[\s\S]*ENOENT/,
    );
  });

  it("JSON 破損は fail-closed (throw)", () => {
    fs.writeFileSync(file, "{broken");
    expect(() => assertUnifiedProfile(file)).toThrow(/壊れています/);
  });

  it("違反があれば全件を列挙して throw する", () => {
    const s = validSettings();
    s.permissions.deny = [];
    s.sandbox.enabled = false;
    fs.writeFileSync(file, JSON.stringify(s));
    try {
      assertUnifiedProfile(file);
      expect.unreachable("throw されるはず");
    } catch (err) {
      const msg = (err as Error).message;
      for (const rule of REQUIRED_DENY) expect(msg).toContain(rule);
      expect(msg).toContain("sandbox.enabled");
    }
  });
});
