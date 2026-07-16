import { describe, expect, it, vi } from "vitest";
import type { ProgressFile } from "@/lib/runs/progress";

const fetchRunGithubStateMock = vi.fn();
vi.mock("../fetchers", () => ({
  fetchRunGithubState: (...args: unknown[]) => fetchRunGithubStateMock(...args),
}));

const { joinProgressFilesWithGithub } = await import("../runJoin");

function makeFile(overrides: Partial<ProgressFile> = {}): ProgressFile {
  return {
    schemaVersion: 1,
    repo: "owner/name",
    issueNumber: 156,
    title: "テスト issue",
    phase: "implementing",
    updatedAt: "2026-07-15T00:00:00Z",
    escalation: null,
    session: null,
    nodes: [
      {
        key: "t1",
        title: "サブタスク1",
        dependsOn: [],
        liveStatus: "implementing",
        subIssue: 70,
        prNumber: 77,
        escalation: null,
      },
    ],
    ...overrides,
  };
}

describe("joinProgressFilesWithGithub", () => {
  it("subIssue/prNumberをキーにGitHubの確定状態をノードへ重ねる", async () => {
    fetchRunGithubStateMock.mockResolvedValueOnce({
      issues: new Map([[70, { number: 70, state: "OPEN", url: "u1" }]]),
      pullRequests: new Map([
        [77, { number: 77, state: "OPEN", isDraft: true, mergeable: "MERGEABLE", reviewDecision: null, url: "u2" }],
      ]),
    });

    const [joined] = await joinProgressFilesWithGithub([makeFile()]);

    expect(joined.githubFetchError).toBeNull();
    expect(joined.nodes[0].githubIssue?.state).toBe("OPEN");
    expect(joined.nodes[0].githubPullRequest?.isDraft).toBe(true);
  });

  it("subIssue/prNumberがnullのノードはGitHub状態もnullのまま", async () => {
    fetchRunGithubStateMock.mockResolvedValueOnce({ issues: new Map(), pullRequests: new Map() });

    const file = makeFile({
      nodes: [
        {
          key: "t1",
          title: "サブタスク1",
          dependsOn: [],
          liveStatus: "queued",
          subIssue: null,
          prNumber: null,
          escalation: null,
        },
      ],
    });

    const [joined] = await joinProgressFilesWithGithub([file]);

    expect(joined.nodes[0].githubIssue).toBeNull();
    expect(joined.nodes[0].githubPullRequest).toBeNull();
    expect(fetchRunGithubStateMock).toHaveBeenCalledWith("owner/name", [], []);
  });

  it("1ファイルの取得に失敗しても他ファイルのjoinは継続する(fail-safe)", async () => {
    fetchRunGithubStateMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        issues: new Map([[70, { number: 70, state: "OPEN", url: "u1" }]]),
        pullRequests: new Map(),
      });

    const [failed, ok] = await joinProgressFilesWithGithub([
      makeFile({ issueNumber: 1 }),
      makeFile({ issueNumber: 2 }),
    ]);

    expect(failed.githubFetchError).toBe("network down");
    expect(failed.nodes[0].githubIssue).toBeNull();
    expect(ok.githubFetchError).toBeNull();
    expect(ok.nodes[0].githubIssue?.state).toBe("OPEN");
  });
});
