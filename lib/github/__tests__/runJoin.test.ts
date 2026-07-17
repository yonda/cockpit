import { describe, expect, it, vi } from "vitest";
import type { ProgressFile } from "@/lib/runs/progress";

const fetchRunGithubStateMock = vi.fn();
vi.mock("../fetchers", async () => {
  const actual = await vi.importActual<typeof import("../fetchers")>("../fetchers");
  return {
    githubRefKey: actual.githubRefKey,
    fetchRunGithubState: (...args: unknown[]) => fetchRunGithubStateMock(...args),
  };
});

const { joinProgressFilesWithGithub } = await import("../runJoin");
const { githubRefKey } = await import("../fetchers");

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
      issues: new Map([[githubRefKey("owner/name", 70), { number: 70, state: "OPEN", url: "u1" }]]),
      pullRequests: new Map([
        [
          githubRefKey("owner/name", 77),
          { number: 77, state: "OPEN", isDraft: true, mergeable: "MERGEABLE", reviewDecision: null, url: "u2" },
        ],
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
    expect(fetchRunGithubStateMock).toHaveBeenCalledWith([
      { repo: "owner/name", issueNumbers: [], prNumbers: [] },
    ]);
  });

  it("ノードのrepoが指定されていればそのリポジトリの状態を重ねる(クロスリポジトリのrun)", async () => {
    fetchRunGithubStateMock.mockResolvedValueOnce({
      issues: new Map([
        [githubRefKey("owner/name", 70), { number: 70, state: "CLOSED", url: "u1" }],
        [githubRefKey("owner/other", 8859), { number: 8859, state: "OPEN", url: "u3" }],
      ]),
      pullRequests: new Map([
        [
          githubRefKey("owner/other", 8862),
          { number: 8862, state: "OPEN", isDraft: true, mergeable: "MERGEABLE", reviewDecision: null, url: "u4" },
        ],
      ]),
    });

    const file = makeFile({
      nodes: [
        { key: "t1", title: "自repo", dependsOn: [], liveStatus: "handed_off", subIssue: 70, prNumber: null, escalation: null },
        {
          key: "t2",
          repo: "owner/other",
          title: "別repo",
          dependsOn: [],
          liveStatus: "handed_off",
          subIssue: 8859,
          prNumber: 8862,
          escalation: null,
        },
      ],
    });

    const [joined] = await joinProgressFilesWithGithub([file]);

    expect(fetchRunGithubStateMock).toHaveBeenCalledWith([
      { repo: "owner/name", issueNumbers: [70], prNumbers: [] },
      { repo: "owner/other", issueNumbers: [8859], prNumbers: [8862] },
    ]);
    expect(joined.githubFetchError).toBeNull();
    expect(joined.nodes[0].githubIssue?.state).toBe("CLOSED");
    expect(joined.nodes[1].githubIssue?.state).toBe("OPEN");
    expect(joined.nodes[1].githubPullRequest?.number).toBe(8862);
  });

  it("解決できないノードがあっても同じrunの他ノードのGitHub状態は残る", async () => {
    fetchRunGithubStateMock.mockResolvedValueOnce({
      issues: new Map([[githubRefKey("owner/name", 70), { number: 70, state: "OPEN", url: "u1" }]]),
      pullRequests: new Map(),
    });

    const file = makeFile({
      nodes: [
        { key: "t1", title: "解決できる", dependsOn: [], liveStatus: "handed_off", subIssue: 70, prNumber: null, escalation: null },
        { key: "t2", title: "解決できない", dependsOn: [], liveStatus: "handed_off", subIssue: 8859, prNumber: null, escalation: null },
      ],
    });

    const [joined] = await joinProgressFilesWithGithub([file]);

    expect(joined.githubFetchError).toBeNull();
    expect(joined.nodes[0].githubIssue?.state).toBe("OPEN");
    expect(joined.nodes[1].githubIssue).toBeNull();
  });

  it("同じ番号を複数ノードが参照していても問い合わせは1回にまとめる", async () => {
    fetchRunGithubStateMock.mockResolvedValueOnce({ issues: new Map(), pullRequests: new Map() });

    const file = makeFile({
      nodes: [
        { key: "t1", title: "a", dependsOn: [], liveStatus: "queued", subIssue: 70, prNumber: null, escalation: null },
        { key: "t2", title: "b", dependsOn: [], liveStatus: "queued", subIssue: 70, prNumber: null, escalation: null },
      ],
    });

    await joinProgressFilesWithGithub([file]);

    expect(fetchRunGithubStateMock).toHaveBeenCalledWith([
      { repo: "owner/name", issueNumbers: [70], prNumbers: [] },
    ]);
  });

  it("1ファイルの取得に失敗しても他ファイルのjoinは継続する(fail-safe)", async () => {
    fetchRunGithubStateMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        issues: new Map([[githubRefKey("owner/name", 70), { number: 70, state: "OPEN", url: "u1" }]]),
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
