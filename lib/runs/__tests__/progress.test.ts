import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseProgress, writeProgressAtomic } from "../progress";
import type { ProgressFile } from "../progress";

const validJson = JSON.stringify({
  schemaVersion: 1,
  repo: "owner/name",
  issueNumber: 70,
  title: "テスト issue",
  phase: "implementing",
  updatedAt: "2026-07-14T06:00:00Z",
  escalation: null,
  nodes: [
    {
      key: "t1",
      title: "サブタスク1",
      dependsOn: [],
      liveStatus: "implementing",
      activity: "実装中: xxx を追加",
      subIssue: 71,
      prNumber: 77,
      escalation: null,
    },
  ],
});

describe("parseProgress", () => {
  it("正常な JSON をパースできる", () => {
    const parsed = parseProgress(validJson);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.repo).toBe("owner/name");
    expect(parsed.phase).toBe("implementing");
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].key).toBe("t1");
    expect(parsed.nodes[0].subIssue).toBe(71);
  });

  it('phase "monitoring"（全 PR 提出後のマージ監視フェーズ）をパースできる', () => {
    // issue-driver skill は全ノードの PR を出したあと phase を monitoring にする。
    // レンズの enum に monitoring が無いと run 全体がスキップされる回帰を防ぐ (#166)。
    const data = JSON.parse(validJson);
    data.phase = "monitoring";
    data.nodes[0].liveStatus = "handed_off";
    expect(parseProgress(JSON.stringify(data)).phase).toBe("monitoring");
  });

  it("escalation ありのファイルもパースできる", () => {
    const withEscalation = JSON.stringify({
      schemaVersion: 1,
      repo: "owner/name",
      issueNumber: 70,
      title: "テスト issue",
      phase: "escalated",
      updatedAt: "2026-07-14T06:00:00Z",
      escalation: {
        reason: "spec_conflict",
        detail: "要求 A と B が両立しない",
        options: ["A を優先", "B を優先"],
        recommendation: "A を優先する",
        at: "2026-07-14T06:00:00Z",
      },
      nodes: [],
    });
    const parsed = parseProgress(withEscalation);
    expect(parsed.escalation?.reason).toBe("spec_conflict");
  });

  it("不正な JSON 文字列で throw する", () => {
    expect(() => parseProgress("{not json")).toThrow();
  });

  it("トップレベルが配列だと throw する", () => {
    expect(() => parseProgress("[]")).toThrow();
  });

  it("必須フィールド欠落（repo）で throw する", () => {
    const data = JSON.parse(validJson);
    delete data.repo;
    expect(() => parseProgress(JSON.stringify(data))).toThrow(/repo/);
  });

  it("必須フィールド欠落（nodes）で throw する", () => {
    const data = JSON.parse(validJson);
    delete data.nodes;
    expect(() => parseProgress(JSON.stringify(data))).toThrow(/nodes/);
  });

  it("不正な phase enum で throw する", () => {
    const data = JSON.parse(validJson);
    data.phase = "not_a_phase";
    expect(() => parseProgress(JSON.stringify(data))).toThrow(/phase/);
  });

  it("不正な liveStatus enum で throw する", () => {
    const data = JSON.parse(validJson);
    data.nodes[0].liveStatus = "not_a_status";
    expect(() => parseProgress(JSON.stringify(data))).toThrow(/liveStatus/);
  });

  it("不正な escalation.reason enum で throw する", () => {
    const data = JSON.parse(validJson);
    data.escalation = {
      reason: "not_a_reason",
      detail: "d",
      options: [],
      recommendation: "r",
      at: "2026-07-14T06:00:00Z",
    };
    expect(() => parseProgress(JSON.stringify(data))).toThrow(/reason/);
  });
});

describe("writeProgressAtomic", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const sample: ProgressFile = {
    schemaVersion: 1,
    repo: "owner/name",
    issueNumber: 70,
    title: "テスト issue",
    phase: "implementing",
    updatedAt: "2026-07-14T06:00:00Z",
    escalation: null,
    nodes: [],
  };

  it("指定パスにファイルを書き、内容が一致する", () => {
    dir = mkdtempSync(join(tmpdir(), "progress-test-"));
    const path = join(dir, "70.json");

    writeProgressAtomic(path, sample);

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(sample);
  });

  it("親ディレクトリが無ければ作成する", () => {
    dir = mkdtempSync(join(tmpdir(), "progress-test-"));
    const path = join(dir, "owner__name", "70.json");

    expect(existsSync(join(dir, "owner__name"))).toBe(false);

    writeProgressAtomic(path, sample);

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(sample);
  });

  it("一時ファイルを残さない（temp→rename で置換）", () => {
    dir = mkdtempSync(join(tmpdir(), "progress-test-"));
    const path = join(dir, "70.json");

    writeProgressAtomic(path, sample);

    const entries = readdirSync(dir);
    expect(entries).toEqual(["70.json"]);
  });

  it("既存ファイルを新しい内容で置き換える", () => {
    dir = mkdtempSync(join(tmpdir(), "progress-test-"));
    const path = join(dir, "70.json");

    writeProgressAtomic(path, sample);
    const updated: ProgressFile = { ...sample, phase: "done" };
    writeProgressAtomic(path, updated);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(updated);
  });
});
