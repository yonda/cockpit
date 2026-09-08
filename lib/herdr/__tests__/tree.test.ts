import { describe, expect, it } from "vitest";
import {
  buildHerdrTree,
  defaultSelectedPaneId,
  flattenPaneIds,
  paneShortId,
} from "../tree";
import type { HerdrPane, HerdrState, HerdrTab, HerdrWorkspace } from "../types";

function workspace(
  workspaceId: string,
  number: number,
  overrides: Partial<HerdrWorkspace> = {},
): HerdrWorkspace {
  return {
    workspaceId,
    number,
    label: workspaceId,
    agentStatus: "idle",
    focused: false,
    paneCount: 0,
    tabCount: 0,
    activeTabId: `${workspaceId}:t1`,
    worktree: null,
    ...overrides,
  };
}

function tab(workspaceId: string, number: number): HerdrTab {
  return {
    tabId: `${workspaceId}:t${number}`,
    workspaceId,
    number,
    label: String(number),
    agentStatus: "idle",
    focused: false,
    paneCount: 0,
  };
}

function pane(
  workspaceId: string,
  tabNumber: number,
  paneNumber: number,
  overrides: Partial<HerdrPane> = {},
): HerdrPane {
  return {
    paneId: `${workspaceId}:p${paneNumber}`,
    tabId: `${workspaceId}:t${tabNumber}`,
    workspaceId,
    agent: null,
    agentStatus: "unknown",
    cwd: "~/src/x",
    foregroundCwd: null,
    focused: false,
    sessionId: null,
    title: null,
    terminalTitle: null,
    tokens: {},
    stateLabels: {},
    ...overrides,
  };
}

describe("buildHerdrTree", () => {
  it("workspace は focused に関係なく番号順に並ぶ", () => {
    const state: HerdrState = {
      // fetchHerdrState は focused を先頭に寄せるので、その並びを入力にする
      workspaces: [
        workspace("w3", 3, { focused: true }),
        workspace("w1", 1),
        workspace("w2", 2),
      ],
      tabs: [],
      panes: [],
    };
    expect(buildHerdrTree(state).map((w) => w.workspace.workspaceId)).toEqual([
      "w1",
      "w2",
      "w3",
    ]);
  });

  it("tab は番号順、pane は ID 末尾の番号順に並ぶ (p10 が p2 の後)", () => {
    const state: HerdrState = {
      workspaces: [workspace("w1", 1)],
      tabs: [tab("w1", 2), tab("w1", 1)],
      panes: [pane("w1", 2, 10), pane("w1", 2, 2), pane("w1", 1, 1)],
    };
    const [w] = buildHerdrTree(state);
    expect(w.tabs.map((t) => t.tabId)).toEqual(["w1:t1", "w1:t2"]);
    expect(w.tabs[1].panes.map((p) => p.paneId)).toEqual(["w1:p2", "w1:p10"]);
  });

  it("tab.list が無い server でも pane の tabId で束ねる", () => {
    const state: HerdrState = {
      workspaces: [workspace("w1", 1)],
      tabs: [],
      panes: [pane("w1", 1, 1), pane("w1", 2, 3)],
    };
    const [w] = buildHerdrTree(state);
    expect(w.tabs.map((t) => [t.tabId, t.tab])).toEqual([
      ["w1:t1", null],
      ["w1:t2", null],
    ]);
  });

  it("workspace.list に無い workspace の pane も末尾に出す", () => {
    const state: HerdrState = {
      workspaces: [workspace("w1", 1)],
      tabs: [],
      panes: [pane("w9", 1, 1), pane("w1", 1, 1)],
    };
    const tree = buildHerdrTree(state);
    expect(tree.map((w) => w.workspace.workspaceId)).toEqual(["w1", "w9"]);
    expect(tree[1].workspace.label).toBe("w9");
  });

  it("pane が無い tab も (tab.list にあれば) 空で残す", () => {
    const state: HerdrState = {
      workspaces: [workspace("w1", 1)],
      tabs: [tab("w1", 1), tab("w1", 2)],
      panes: [pane("w1", 1, 1)],
    };
    const [w] = buildHerdrTree(state);
    expect(w.tabs.map((t) => t.panes.length)).toEqual([1, 0]);
  });
});

describe("defaultSelectedPaneId", () => {
  const base = (panes: HerdrPane[]): HerdrState => ({
    workspaces: [workspace("w1", 1)],
    tabs: [],
    panes,
  });

  it("フォーカス中の pane を優先する", () => {
    const tree = buildHerdrTree(
      base([
        pane("w1", 1, 1, { agent: "claude" }),
        pane("w1", 1, 2, { focused: true }),
      ]),
    );
    expect(defaultSelectedPaneId(tree)).toBe("w1:p2");
  });

  it("フォーカスが無ければ最初の agent pane、それも無ければ最初の pane", () => {
    expect(
      defaultSelectedPaneId(
        buildHerdrTree(base([pane("w1", 1, 1), pane("w1", 1, 2, { agent: "codex" })])),
      ),
    ).toBe("w1:p2");
    expect(defaultSelectedPaneId(buildHerdrTree(base([pane("w1", 1, 5)])))).toBe(
      "w1:p5",
    );
    expect(defaultSelectedPaneId(buildHerdrTree(base([])))).toBeNull();
  });
});

describe("flattenPaneIds / paneShortId", () => {
  it("表示順のまま平らにする", () => {
    const tree = buildHerdrTree({
      workspaces: [workspace("w2", 2), workspace("w1", 1)],
      tabs: [],
      panes: [pane("w2", 1, 1), pane("w1", 1, 2), pane("w1", 1, 1)],
    });
    expect(flattenPaneIds(tree)).toEqual(["w1:p1", "w1:p2", "w2:p1"]);
  });

  it("paneShortId は ':' 以降だけを返す", () => {
    expect(paneShortId("w8F:p1")).toBe("p1");
    expect(paneShortId("p1")).toBe("p1");
  });
});
