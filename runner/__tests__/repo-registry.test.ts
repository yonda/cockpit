import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRegistry } from "../repo-registry";

let dir: string;
let existingRepoPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "repos-"));
  existingRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "repo-clone-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(existingRepoPath, { recursive: true, force: true });
});

function writeRepos(entries: unknown): string {
  const file = path.join(dir, "repos.json");
  fs.writeFileSync(file, JSON.stringify({ repos: entries }));
  return file;
}

describe("loadRegistry", () => {
  it("登録リポジトリを解決する", () => {
    const file = writeRepos([
      { repo: "acme/widget", path: existingRepoPath, baseBranch: "develop", tokenOwner: "acme" },
    ]);
    const reg = loadRegistry(file);
    const cfg = reg.resolve("acme/widget");
    expect(cfg).toEqual({
      repo: "acme/widget",
      path: existingRepoPath,
      baseBranch: "develop",
      tokenOwner: "acme",
    });
  });

  it("未登録リポジトリは null", () => {
    const file = writeRepos([]);
    expect(loadRegistry(file).resolve("acme/widget")).toBeNull();
  });

  it("path が存在しないエントリは除外する", () => {
    const file = writeRepos([
      { repo: "acme/widget", path: "/no/such/dir", baseBranch: "main", tokenOwner: "acme" },
    ]);
    expect(loadRegistry(file).resolve("acme/widget")).toBeNull();
  });

  it("必須フィールド欠如のエントリは除外する", () => {
    const file = writeRepos([
      { repo: "acme/widget", path: existingRepoPath, baseBranch: "", tokenOwner: "acme" },
    ]);
    expect(loadRegistry(file).resolve("acme/widget")).toBeNull();
  });

  it("ファイルが無ければ空レジストリ (throw しない)", () => {
    const reg = loadRegistry(path.join(dir, "missing.json"));
    expect(reg.all()).toEqual([]);
    expect(reg.resolve("acme/widget")).toBeNull();
  });

  it("壊れた JSON でも空レジストリ", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ not json");
    expect(loadRegistry(file).all()).toEqual([]);
  });
});
