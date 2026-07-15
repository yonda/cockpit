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

  it("壊れたJSONファイルはskipし、他の正常なファイルは読める(fail-safe)", () => {
    dir = mkdtempSync(join(tmpdir(), "runs-list-test-"));
    mkdirSync(join(dir, "owner__repo-a"), { recursive: true });
    writeFileSync(join(dir, "owner__repo-a", "70.json"), validJson(70));
    writeFileSync(join(dir, "owner__repo-a", "broken.json"), "{ not valid json");
    writeFileSync(join(dir, "owner__repo-a", "missing-field.json"), JSON.stringify({ schemaVersion: 1 }));

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
});
