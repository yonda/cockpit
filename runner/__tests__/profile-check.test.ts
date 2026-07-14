import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertUnifiedProfile,
  checkUnifiedProfile,
  REQUIRED_DENY,
} from "../profile-check";

// 実行環境統一 (#85): runner は settings を注入せず、ユーザー settings の
// 不変条件を起動時に検証する (fail-closed)。ここではその判定を固定する。
// 不変条件の実測根拠は docs/permission-philosophy.md「実行環境の統一」。

function validSettings() {
  return {
    permissions: {
      defaultMode: "acceptEdits",
      allow: ["Bash(git push:*)", "Bash(gh pr create:*)", "Bash(pnpm:*)"],
      deny: ["Bash(sudo *)", ...REQUIRED_DENY],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
    },
  };
}

describe("checkUnifiedProfile", () => {
  it("統一プロファイルの条件を満たす settings は違反ゼロ", () => {
    expect(checkUnifiedProfile(validSettings())).toEqual([]);
  });

  it("bypassPermissions は違反 (実測: Seatbelt 封じ込めを無効化する)", () => {
    const s = validSettings();
    s.permissions.defaultMode = "bypassPermissions";
    expect(checkUnifiedProfile(s).join()).toContain("bypassPermissions");
  });

  it("層3 deny の欠落を 1 件ずつ検出する", () => {
    for (const rule of REQUIRED_DENY) {
      const s = validSettings();
      s.permissions.deny = s.permissions.deny.filter((r) => r !== rule);
      const v = checkUnifiedProfile(s);
      expect(v.join()).toContain(rule);
    }
  });

  it("広すぎる allow (gh api / 素の gh / 素の git) を拒否する", () => {
    for (const rule of ["Bash(gh api:*)", "Bash(gh:*)", "Bash(git:*)"]) {
      const s = validSettings();
      s.permissions.allow.push(rule);
      expect(checkUnifiedProfile(s).join()).toContain(rule);
    }
  });

  it("sandbox 無効 / fail-open は違反", () => {
    const noSandbox = validSettings();
    noSandbox.sandbox.enabled = false;
    expect(checkUnifiedProfile(noSandbox).join()).toContain("sandbox.enabled");

    const failOpen = validSettings();
    failOpen.sandbox.failIfUnavailable = false;
    expect(checkUnifiedProfile(failOpen).join()).toContain("failIfUnavailable");
  });

  it("オブジェクトでない settings は違反", () => {
    expect(checkUnifiedProfile(null).length).toBeGreaterThan(0);
    expect(checkUnifiedProfile("{}").length).toBeGreaterThan(0);
  });

  it("permissions / sandbox 欠落でも throw せず違反として列挙する", () => {
    const v = checkUnifiedProfile({});
    expect(v.length).toBeGreaterThan(0);
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

  it("ファイル不在は fail-closed (throw)", () => {
    expect(() => assertUnifiedProfile(path.join(dir, "nope.json"))).toThrow(
      /読めません/,
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
