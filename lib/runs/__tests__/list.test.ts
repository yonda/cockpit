import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProgressFiles } from "../list";

const validJson = (issueNumber: number) =>
  JSON.stringify({
    schemaVersion: 1,
    repo: "owner/name",
    issueNumber,
    title: `テスト issue ${issueNumber}`,
    phase: "implementing",
    updatedAt: "2026-07-14T06:00:00Z",
    escalation: null,
    nodes: [],
  });

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("listProgressFiles", () => {
  it("runsディレクトリが無ければ空の結果を返す", () => {
    dir = mkdtempSync(join(tmpdir(), "runs-list-test-"));
    const result = listProgressFiles(join(dir, "does-not-exist"));
    expect(result.files).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("複数リポジトリ・複数issueのrunファイルを全件パースする", () => {
    dir = mkdtempSync(join(tmpdir(), "runs-list-test-"));
    mkdirSync(join(dir, "owner__repo-a"), { recursive: true });
    mkdirSync(join(dir, "owner__repo-b"), { recursive: true });
    writeFileSync(join(dir, "owner__repo-a", "70.json"), validJson(70));
    writeFileSync(join(dir, "owner__repo-a", "71.json"), validJson(71));
    writeFileSync(join(dir, "owner__repo-b", "10.json"), validJson(10));

    const result = listProgressFiles(dir);

    expect(result.files).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.files.map((f) => f.issueNumber).sort()).toEqual([10, 70, 71]);
  });

  it("壊れたrunファイルはskipし、他の正常なファイルは読める(fail-safe)", () => {
    dir = mkdtempSync(join(tmpdir(), "runs-list-test-"));
    mkdirSync(join(dir, "owner__repo-a"), { recursive: true });
    writeFileSync(join(dir, "owner__repo-a", "70.json"), validJson(70));
    writeFileSync(join(dir, "owner__repo-a", "71.json"), "{ not valid json");
    writeFileSync(join(dir, "owner__repo-a", "72.json"), JSON.stringify({ schemaVersion: 1 }));

    const result = listProgressFiles(dir);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].issueNumber).toBe(70);
    expect(result.skipped).toHaveLength(2);
  });

  it("jsonでないファイルは無視する", () => {
    dir = mkdtempSync(join(tmpdir(), "runs-list-test-"));
    mkdirSync(join(dir, "owner__repo-a"), { recursive: true });
    writeFileSync(join(dir, "owner__repo-a", "70.json"), validJson(70));
    writeFileSync(join(dir, "owner__repo-a", ".DS_Store"), "");

    const result = listProgressFiles(dir);

    expect(result.files).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("<issueNumber>.json 以外の .json は run として読まない", () => {
    // 実際に起きた汚染: 別の lead が run ディレクトリにバックアップと作業ファイルを置き、
    // バックアップが同じ issue の run として二重に読まれた(React の key 重複 → 二重描画)。
    dir = mkdtempSync(join(tmpdir(), "runs-list-test-"));
    mkdirSync(join(dir, "owner__repo-a"), { recursive: true });
    writeFileSync(join(dir, "owner__repo-a", "41.json"), validJson(41));
    writeFileSync(join(dir, "owner__repo-a", "41-baseline-backup.json"), validJson(41));

    const result = listProgressFiles(dir);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].issueNumber).toBe(41);
  });

  it("run でない作業ファイルは「破損」に計上しない (本物の破損を隠さない)", () => {
    dir = mkdtempSync(join(tmpdir(), "runs-list-test-"));
    mkdirSync(join(dir, "owner__repo-a"), { recursive: true });
    writeFileSync(join(dir, "owner__repo-a", "70.json"), validJson(70));
    writeFileSync(join(dir, "owner__repo-a", "some-scratch-data.json"), JSON.stringify({ a: 1 }));

    const result = listProgressFiles(dir);

    expect(result.files).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("原子的書き込みの一時ファイルを run として読まない", () => {
    dir = mkdtempSync(join(tmpdir(), "runs-list-test-"));
    mkdirSync(join(dir, "owner__repo-a"), { recursive: true });
    writeFileSync(join(dir, "owner__repo-a", "70.json"), validJson(70));
    writeFileSync(join(dir, "owner__repo-a", "70.json.tmp"), validJson(70));
    writeFileSync(join(dir, "owner__repo-a", ".1784250000-123.tmp"), "");

    const result = listProgressFiles(dir);

    expect(result.files).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });
});
