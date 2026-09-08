import { createConnection } from "node:net";
import { homedir } from "node:os";
import type {
  HerdrPane,
  HerdrState,
  HerdrStatus,
  HerdrTab,
  HerdrWorkspace,
} from "./types";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type HerdrRequest = { id: string; method: string; params: Record<string, JsonValue> };
type HerdrResponse = { id: string; result?: unknown; error?: unknown };

const SOCKET_PATH =
  process.env.HERDR_SOCKET_PATH ?? `${homedir()}/.config/herdr/herdr.sock`;
const REQUEST_TIMEOUT_MS = 5_000;

function callHerdr(request: HerdrRequest): Promise<HerdrResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH);
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`herdr socket timeout after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as HerdrResponse;
          // server が method 名を知らないとき (protocol 差) は id が空の
          // invalid_request が返る。それも自分宛てとみなして即座に返す。
          const mine =
            parsed.id === request.id || (parsed.error && !parsed.id);
          if (mine) {
            settle(() => {
              socket.end();
              resolve(parsed);
            });
            return;
          }
        } catch {
          // skip malformed line
        }
      }
    });

    socket.on("error", (err) => {
      settle(() => reject(err));
    });

    socket.on("close", () => {
      settle(() => reject(new Error(`herdr socket closed before responding to ${request.id}`)));
    });
  });
}

function asStatus(value: unknown): HerdrStatus {
  if (
    value === "idle" ||
    value === "working" ||
    value === "blocked" ||
    value === "done"
  ) {
    return value;
  }
  return "unknown";
}

function abbreviateHome(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function extractList(
  response: HerdrResponse,
  key: "workspaces" | "panes" | "tabs",
): unknown[] {
  const result = response.result as { [k: string]: unknown } | undefined;
  const list = result?.[key];
  return Array.isArray(list) ? list : [];
}

function toWorkspace(w: unknown): HerdrWorkspace {
  const ws = w as Record<string, unknown>;
  const wt = ws.worktree as Record<string, unknown> | null | undefined;
  return {
    workspaceId: String(ws.workspace_id),
    number: Number(ws.number ?? 0),
    label: String(ws.label ?? ws.workspace_id),
    agentStatus: asStatus(ws.agent_status),
    focused: Boolean(ws.focused),
    paneCount: Number(ws.pane_count ?? 0),
    tabCount: Number(ws.tab_count ?? 0),
    activeTabId: String(ws.active_tab_id ?? ""),
    worktree:
      wt && typeof wt === "object"
        ? {
            repoName: String(wt.repo_name ?? ""),
            checkoutPath: abbreviateHome(String(wt.checkout_path ?? "")),
            isLinkedWorktree: Boolean(wt.is_linked_worktree),
          }
        : null,
  };
}

function toTab(t: unknown): HerdrTab {
  const tab = t as Record<string, unknown>;
  return {
    tabId: String(tab.tab_id),
    workspaceId: String(tab.workspace_id),
    number: Number(tab.number ?? 0),
    label: String(tab.label ?? tab.number ?? ""),
    agentStatus: asStatus(tab.agent_status),
    focused: Boolean(tab.focused),
    paneCount: Number(tab.pane_count ?? 0),
  };
}

function toPane(p: unknown): HerdrPane {
  const pane = p as Record<string, unknown>;
  const session = pane.agent_session as
    | { kind?: string; value?: string }
    | undefined;
  return {
    paneId: String(pane.pane_id),
    tabId: String(pane.tab_id),
    workspaceId: String(pane.workspace_id),
    agent: pane.agent ? String(pane.agent) : null,
    agentStatus: asStatus(pane.agent_status),
    cwd: abbreviateHome(String(pane.cwd ?? "")),
    foregroundCwd: pane.foreground_cwd
      ? abbreviateHome(String(pane.foreground_cwd))
      : null,
    focused: Boolean(pane.focused),
    sessionId:
      session?.kind === "id" && session.value ? String(session.value) : null,
    title: optionalString(pane.title),
    terminalTitle: optionalString(
      pane.terminal_title_stripped ?? pane.terminal_title,
    ),
    tokens: asStringMap(pane.tokens),
    stateLabels: asStringMap(pane.state_labels),
  };
}

export async function fetchHerdrState(): Promise<HerdrState> {
  const [wsResp, tabResp, paneResp] = await Promise.all([
    callHerdr({ id: "workspaces", method: "workspace.list", params: {} }),
    callHerdr({ id: "tabs", method: "tab.list", params: {} }),
    callHerdr({ id: "panes", method: "pane.list", params: {} }),
  ]);

  const workspaces = extractList(wsResp, "workspaces").map(toWorkspace);
  // tab.list が失敗しても workspace / pane だけで表示は成り立つ
  const tabs = extractList(tabResp, "tabs").map(toTab);
  const panes = extractList(paneResp, "panes").map(toPane);

  workspaces.sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    return a.number - b.number;
  });

  return { workspaces, tabs, panes };
}

function errorMessage(response: HerdrResponse): string | null {
  if (!response.error) return null;
  const err = response.error as { message?: unknown };
  return typeof err.message === "string" ? err.message : JSON.stringify(response.error);
}

function unwrap<T>(response: HerdrResponse, label: string): T {
  const error = errorMessage(response);
  if (error) throw new Error(`${label}: ${error}`);
  return response.result as T;
}

// pane 1 枚の生 cwd (home 省略なし) 付き情報。git 操作などパスをそのまま
// 使いたい server 側の呼び出し向け。
export async function getHerdrPane(
  paneId: string,
): Promise<{ pane: HerdrPane; rawCwd: string | null }> {
  const resp = await callHerdr({
    id: "pane-get",
    method: "pane.get",
    params: { pane_id: paneId },
  });
  const result = unwrap<{ pane?: Record<string, unknown> }>(resp, "pane.get");
  if (!result?.pane) throw new Error("pane.get: empty result");
  const raw = result.pane;
  const rawCwd = optionalString(raw.foreground_cwd) ?? optionalString(raw.cwd);
  return { pane: toPane(raw), rawCwd };
}

export type HerdrReadSource = "visible" | "recent" | "recent_unwrapped";

export async function readHerdrPane(
  paneId: string,
  source: HerdrReadSource,
  lines: number,
): Promise<{ text: string; truncated: boolean }> {
  const resp = await callHerdr({
    id: "pane-read",
    method: "pane.read",
    params: { pane_id: paneId, source, lines, format: "text", strip_ansi: true },
  });
  const result = unwrap<{ read?: { text?: unknown; truncated?: unknown } }>(
    resp,
    "pane.read",
  );
  return {
    text: typeof result?.read?.text === "string" ? result.read.text : "",
    truncated: Boolean(result?.read?.truncated),
  };
}

// テキストを pane に流し込み、Enter を押す。`herdr pane run` と同じ手順。
// agent.prompt (protocol 22) は古い server に無いので使わない。
export async function sendHerdrPrompt(paneId: string, text: string): Promise<void> {
  const textResp = await callHerdr({
    id: "send-text",
    method: "pane.send_text",
    params: { pane_id: paneId, text },
  });
  unwrap(textResp, "pane.send_text");
  const keysResp = await callHerdr({
    id: "send-keys",
    method: "pane.send_keys",
    params: { pane_id: paneId, keys: ["Enter"] },
  });
  unwrap(keysResp, "pane.send_keys");
}

// herdr 上で workspace (と、あれば tab / pane) をフォーカスする。
// pane.focus は protocol 22 以降にしかないため、失敗したら tab までの粒度に落とす。
export async function focusHerdrTarget(
  workspaceId: string,
  tabId?: string,
  paneId?: string,
): Promise<void> {
  const wsResp = await callHerdr({
    id: "focus-ws",
    method: "workspace.focus",
    params: { workspace_id: workspaceId },
  });
  const wsError = errorMessage(wsResp);
  if (wsError) throw new Error(`workspace.focus: ${wsError}`);

  if (tabId) {
    const tabResp = await callHerdr({
      id: "focus-tab",
      method: "tab.focus",
      params: { tab_id: tabId },
    });
    const tabError = errorMessage(tabResp);
    if (tabError) throw new Error(`tab.focus: ${tabError}`);
  }

  if (!paneId) return;
  const paneResp = await callHerdr({
    id: "focus-pane",
    method: "pane.focus",
    params: { pane_id: paneId },
  });
  const paneError = errorMessage(paneResp);
  if (paneError) {
    // 古い server は pane.focus を知らない。tab まで合っていれば十分。
    console.warn(`[herdr] pane.focus unavailable: ${paneError}`);
  }
}
