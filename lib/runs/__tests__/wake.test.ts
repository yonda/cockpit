import { describe, expect, it } from "vitest";
import type { ProgressFile } from "../progress";
import { selectWakeTargets } from "../wake";

function file(overrides: Partial<ProgressFile>): ProgressFile {
  return {
    schemaVersion: 1,
    repo: "owner/name",
    issueNumber: 70,
    title: "テスト issue",
    phase: "monitoring",
    updatedAt: "2026-07-16T00:00:00Z",
    escalation: null,
    session: null,
    nodes: [],
    ...overrides,
  };
}

describe("selectWakeTargets", () => {
  it("phase:monitoring の run だけを対象にする", () => {
    const files = [
      file({ issueNumber: 1, phase: "implementing" }),
      file({ issueNumber: 2, phase: "monitoring" }),
      file({ issueNumber: 3, phase: "done" }),
      file({ issueNumber: 4, phase: "reviewing" }),
      file({ issueNumber: 5, phase: "monitoring" }),
    ];
    expect(selectWakeTargets(files).map((t) => t.issueNumber)).toEqual([2, 5]);
  });

  it("issue の GitHub URL を repo と issueNumber から導出する", () => {
    const [target] = selectWakeTargets([
      file({ repo: "yonda/cockpit", issueNumber: 168 }),
    ]);
    expect(target.issueUrl).toBe("https://github.com/yonda/cockpit/issues/168");
  });

  it("担当セッションの連絡先(session)をそのまま運ぶ", () => {
    const session = {
      agmsgTeam: "cockpit",
      agmsgAgent: "cockpit-G",
      herdrPane: "wE:p1F",
      cwd: "/tmp/wt",
    };
    const [target] = selectWakeTargets([file({ session })]);
    expect(target.session).toEqual(session);
    expect(target.repo).toBe("owner/name");
    expect(target.title).toBe("テスト issue");
  });

  it("session が null でも対象に含める（立て直し/連絡先未記録のケース）", () => {
    const targets = selectWakeTargets([file({ session: null })]);
    expect(targets).toHaveLength(1);
    expect(targets[0].session).toBeNull();
  });

  it("monitoring が無ければ空配列", () => {
    expect(selectWakeTargets([file({ phase: "done" })])).toEqual([]);
    expect(selectWakeTargets([])).toEqual([]);
  });
});
