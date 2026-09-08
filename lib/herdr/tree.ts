import type { HerdrPane, HerdrState, HerdrTab, HerdrWorkspace } from "./types";

// herdr のサイドバーと同じ並びに組み直した木。
// workspace は番号順、tab は番号順、pane は ID の末尾番号順。
// focused を先頭に寄せる WIP の並びとは意図的に違え、herdr 側と
// 見比べたときに位置がずれないようにする。
export type HerdrTreeTab = {
  // tab.list が使えない server では null (tabId だけで束ねる)
  tab: HerdrTab | null;
  tabId: string;
  panes: HerdrPane[];
};

export type HerdrTreeWorkspace = {
  workspace: HerdrWorkspace;
  tabs: HerdrTreeTab[];
};

// "w8F:p1" → "p1"。herdr 内部 ID の末尾だけを表示用に使う。
export function paneShortId(paneId: string): string {
  const idx = paneId.lastIndexOf(":");
  return idx >= 0 ? paneId.slice(idx + 1) : paneId;
}

function trailingNumber(id: string): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function byTrailingNumber(a: string, b: string): number {
  return trailingNumber(a) - trailingNumber(b) || a.localeCompare(b);
}

export function buildHerdrTree(state: HerdrState): HerdrTreeWorkspace[] {
  const panesByTab = new Map<string, HerdrPane[]>();
  const tabIdsByWorkspace = new Map<string, Set<string>>();
  for (const pane of state.panes) {
    const arr = panesByTab.get(pane.tabId) ?? [];
    arr.push(pane);
    panesByTab.set(pane.tabId, arr);
    const tabs = tabIdsByWorkspace.get(pane.workspaceId) ?? new Set<string>();
    tabs.add(pane.tabId);
    tabIdsByWorkspace.set(pane.workspaceId, tabs);
  }

  const tabById = new Map(state.tabs.map((t) => [t.tabId, t]));
  for (const tab of state.tabs) {
    const tabs = tabIdsByWorkspace.get(tab.workspaceId) ?? new Set<string>();
    tabs.add(tab.tabId);
    tabIdsByWorkspace.set(tab.workspaceId, tabs);
  }

  const known = new Set(state.workspaces.map((w) => w.workspaceId));
  const extras: HerdrWorkspace[] = [];
  for (const workspaceId of tabIdsByWorkspace.keys()) {
    if (known.has(workspaceId)) continue;
    known.add(workspaceId);
    extras.push({
      workspaceId,
      number: Number.MAX_SAFE_INTEGER,
      label: workspaceId,
      agentStatus: "unknown",
      focused: false,
      paneCount: 0,
      tabCount: 0,
      activeTabId: "",
      worktree: null,
    });
  }

  const workspaces = [...state.workspaces, ...extras].sort(
    (a, b) => a.number - b.number || a.workspaceId.localeCompare(b.workspaceId),
  );

  return workspaces.map((workspace) => {
    const tabIds = [...(tabIdsByWorkspace.get(workspace.workspaceId) ?? [])];
    const tabs: HerdrTreeTab[] = tabIds
      .map((tabId) => ({
        tab: tabById.get(tabId) ?? null,
        tabId,
        panes: (panesByTab.get(tabId) ?? [])
          .slice()
          .sort((a, b) => byTrailingNumber(a.paneId, b.paneId)),
      }))
      .sort((a, b) => {
        const an = a.tab?.number ?? trailingNumber(a.tabId);
        const bn = b.tab?.number ?? trailingNumber(b.tabId);
        return an - bn || a.tabId.localeCompare(b.tabId);
      });
    return { workspace, tabs };
  });
}

// 初期選択: herdr でフォーカス中の pane → 最初の agent pane → 最初の pane。
export function defaultSelectedPaneId(tree: HerdrTreeWorkspace[]): string | null {
  const all = tree.flatMap((w) => w.tabs.flatMap((t) => t.panes));
  return (
    all.find((p) => p.focused)?.paneId ??
    all.find((p) => p.agent)?.paneId ??
    all[0]?.paneId ??
    null
  );
}

// 木の表示順で pane を平らに並べる。キーボードで上下移動するときの順序。
export function flattenPaneIds(tree: HerdrTreeWorkspace[]): string[] {
  return tree.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.paneId)));
}
