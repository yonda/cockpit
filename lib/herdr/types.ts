export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

// この pane のセッションが起動した subagent の集計 (lib/claude/subagents が作る)
export type SubagentSummary = { running: number; total: number };

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
  // transcript 由来の subagent 集計。/api/panes が付ける (無ければ 0 件扱い)
  subagents?: SubagentSummary;
  // 以下は herdr protocol 22 以降でのみ返る。古い server では null / 空。
  // agent 自身が報告するタイトル (Claude Code の ai-title など)
  title: string | null;
  // 端末が OSC で報告するウィンドウタイトル
  terminalTitle: string | null;
  // agent が報告するトークン使用量など。キーと値は agent 側の自由記述
  tokens: Record<string, string>;
  // agent が報告する状態ラベル (例: branch, pr)
  stateLabels: Record<string, string>;
};

export type HerdrTab = {
  tabId: string;
  workspaceId: string;
  number: number;
  label: string;
  agentStatus: HerdrStatus;
  focused: boolean;
  paneCount: number;
};

export type HerdrWorktree = {
  repoName: string;
  checkoutPath: string;
  isLinkedWorktree: boolean;
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
  // protocol 22 以降でのみ返る
  worktree: HerdrWorktree | null;
};

export type HerdrState = {
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
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
      worktree: null,
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
