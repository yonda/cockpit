import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRunnerToken, loadRunnerToken, resolveToken } from "../github-token";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-token-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadRunnerToken", () => {
  it("ファイルの中身を前後空白を除いて返す", () => {
    const file = path.join(dir, "token");
    fs.writeFileSync(file, "github_pat_abc123\n");
    expect(loadRunnerToken(file)).toBe("github_pat_abc123");
  });

  it("ファイルが無ければ throw する (fail-closed)", () => {
    const file = path.join(dir, "missing");
    expect(() => loadRunnerToken(file)).toThrow("runner token file を読めません");
    expect(() => loadRunnerToken(file)).toThrow(file);
  });

  it("ファイルが空 (空白のみ) なら throw する (fail-closed)", () => {
    const file = path.join(dir, "empty");
    fs.writeFileSync(file, "  \n");
    expect(() => loadRunnerToken(file)).toThrow("runner token file が空です");
  });

  it("複数行・複数トークンなら throw する (認証エラーとして遠くで表面化させない)", () => {
    const file = path.join(dir, "multiline");
    fs.writeFileSync(file, "github_pat_abc123\n# rotated 2026-07\n");
    expect(() => loadRunnerToken(file)).toThrow(
      "トークン以外の内容が含まれています",
    );
  });
});

describe("applyRunnerToken", () => {
  it("COCKPIT_RUNNER_TOKEN_FILE のトークンを env.GH_TOKEN に積む", () => {
    const file = path.join(dir, "token");
    fs.writeFileSync(file, "github_pat_weak\n");
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      COCKPIT_RUNNER_TOKEN_FILE: file,
    };
    applyRunnerToken(env);
    expect(env.GH_TOKEN).toBe("github_pat_weak");
  });

  it("ファイルが読めなければ throw し GH_TOKEN を設定しない", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      COCKPIT_RUNNER_TOKEN_FILE: path.join(dir, "missing"),
    };
    expect(() => applyRunnerToken(env)).toThrow("runner token file を読めません");
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

describe("resolveToken", () => {
  let tokensDir: string;
  beforeEach(() => {
    tokensDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokens-"));
  });
  afterEach(() => {
    fs.rmSync(tokensDir, { recursive: true, force: true });
  });

  it("owner のトークンファイルを読む", () => {
    fs.writeFileSync(path.join(tokensDir, "acme"), "github_pat_acme\n");
    expect(resolveToken("acme", tokensDir)).toBe("github_pat_acme");
  });

  it("owner のトークンが無ければ throw (fail-closed)", () => {
    expect(() => resolveToken("acme", tokensDir)).toThrow();
  });

  it("COCKPIT_TOKENS_DIR で既定ディレクトリを上書きできる", () => {
    fs.writeFileSync(path.join(tokensDir, "acme"), "github_pat_acme\n");
    const prev = process.env.COCKPIT_TOKENS_DIR;
    process.env.COCKPIT_TOKENS_DIR = tokensDir;
    try {
      expect(resolveToken("acme")).toBe("github_pat_acme");
    } finally {
      if (prev === undefined) delete process.env.COCKPIT_TOKENS_DIR;
      else process.env.COCKPIT_TOKENS_DIR = prev;
    }
  });
});
