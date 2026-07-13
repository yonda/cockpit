import { describe, expect, it } from "vitest";
import { buildSandboxSettings } from "../sandbox-config";

// PoC (Issue #36 / docs/sandbox-poc.md) の結論を退行検知として固定するテスト。
// 個々の値の「根拠」はモジュール側コメントに書いてあるので、ここでは
// 「この不変条件が崩れたら sandbox の安全性前提が壊れる」ものを最小限で固める。

describe("buildSandboxSettings", () => {
  it("純関数として毎回同値を返す (引数・副作用なし)", () => {
    expect(buildSandboxSettings()).toEqual(buildSandboxSettings());
  });

  it("enabled が true (sandbox を有効化する大前提)", () => {
    expect(buildSandboxSettings().enabled).toBe(true);
  });

  it("failIfUnavailable が true (非 sandbox への黙劇降格を禁止する fail-closed)", () => {
    expect(buildSandboxSettings().failIfUnavailable).toBe(true);
  });

  it("autoAllowBashIfSandboxed が false (Layer 0 が副作用系 Bash を捕捉し続ける)", () => {
    // true にすると canUseTool が完全バイパスされ、保護ブランチ push まで
    // permission-policy の捕捉から外れる。ここは絶対に true にしてはならない。
    expect(buildSandboxSettings().autoAllowBashIfSandboxed).toBe(false);
  });

  it("excludedCommands に gh が含まれる (TLS 回避 + canUseTool 復帰)", () => {
    expect(buildSandboxSettings().excludedCommands).toContain("gh *");
  });

  describe("network", () => {
    it("allowedDomains に npm レジストリと github が含まれる", () => {
      const domains = buildSandboxSettings().network?.allowedDomains ?? [];
      expect(domains).toContain("registry.npmjs.org");
      expect(domains).toContain("github.com");
      expect(domains).toContain("*.github.com");
    });

    it("fonts 系ドメインは含まれない (build は sandbox 外で行うため入れない)", () => {
      const domains = buildSandboxSettings().network?.allowedDomains ?? [];
      expect(domains.some((d) => d.includes("googleapis") || d.includes("gstatic"))).toBe(
        false,
      );
    });

    it("allowAllUnixSockets が true (vitest の UDS bind に必要)", () => {
      expect(buildSandboxSettings().network?.allowAllUnixSockets).toBe(true);
    });
  });

  describe("credentials", () => {
    it("全ての credentials.files エントリが deny", () => {
      const files = buildSandboxSettings().credentials?.files ?? [];
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.mode === "deny")).toBe(true);
    });

    it("~/.ssh と ~/.aws (AWS 認証情報) が deny される", () => {
      const denied = (buildSandboxSettings().credentials?.files ?? [])
        .filter((f) => f.mode === "deny")
        .map((f) => f.path);
      expect(denied).toContain("~/.ssh");
      // ~/.aws ディレクトリ全体を deny することで ~/.aws/credentials も塞がれる。
      expect(denied).toContain("~/.aws");
    });

    it("認証トークンの環境変数が deny される", () => {
      const envVars = buildSandboxSettings().credentials?.envVars ?? [];
      const denied = envVars.filter((e) => e.mode === "deny").map((e) => e.name);
      expect(denied).toContain("GITHUB_TOKEN");
      expect(denied).toContain("ANTHROPIC_API_KEY");
    });
  });
});
