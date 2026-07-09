export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type PaneRecap = {
  title: string | null;
  lastPrompt: string | null;
  lastAssistant: string | null;
  lastActivityAt: string | null;
};

export type HerdrPane = {
  paneId: string;
  tabId: string;
  workspaceId: string;
  agent: string | null;
  agentStatus: HerdrStatus;
  cwd: string;
  foregroundCwd: string | null;
  focused: boolean;
  sessionId: string | null;
  recap?: PaneRecap | null;
};

export type HerdrWorkspace = {
  workspaceId: string;
  number: number;
  label: string;
  agentStatus: HerdrStatus;
  focused: boolean;
  paneCount: number;
  tabCount: number;
  activeTabId: string;
};

export type HerdrState = {
  workspaces: HerdrWorkspace[];
  panes: HerdrPane[];
};

export function panesByWorkspace(
  state: HerdrState,
): Array<{ workspace: HerdrWorkspace; panes: HerdrPane[] }> {
  const groups = new Map<string, HerdrPane[]>();
  for (const pane of state.panes) {
    const arr = groups.get(pane.workspaceId) ?? [];
    arr.push(pane);
    groups.set(pane.workspaceId, arr);
  }

  const known = new Set(state.workspaces.map((w) => w.workspaceId));
  const extras: HerdrWorkspace[] = [];
  for (const pane of state.panes) {
    if (known.has(pane.workspaceId)) continue;
    known.add(pane.workspaceId);
    extras.push({
      workspaceId: pane.workspaceId,
      number: 9999,
      label: pane.workspaceId,
      agentStatus: "unknown",
      focused: false,
      paneCount: (groups.get(pane.workspaceId) ?? []).length,
      tabCount: 0,
      activeTabId: pane.tabId,
    });
  }

  return [...state.workspaces, ...extras].map((workspace) => ({
    workspace,
    panes: (groups.get(workspace.workspaceId) ?? []).slice().sort((a, b) => {
      if (a.focused !== b.focused) return a.focused ? -1 : 1;
      return a.paneId.localeCompare(b.paneId);
    }),
  }));
}
