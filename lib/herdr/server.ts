import { createConnection } from "node:net";
import { homedir } from "node:os";
import type { HerdrPane, HerdrState, HerdrStatus, HerdrWorkspace } from "./types";

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
          if (parsed.id === request.id) {
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

function extractList(
  response: HerdrResponse,
  key: "workspaces" | "panes",
): unknown[] {
  const result = response.result as { [k: string]: unknown } | undefined;
  const list = result?.[key];
  return Array.isArray(list) ? list : [];
}

export async function fetchHerdrState(): Promise<HerdrState> {
  const [wsResp, paneResp] = await Promise.all([
    callHerdr({ id: "workspaces", method: "workspace.list", params: {} }),
    callHerdr({ id: "panes", method: "pane.list", params: {} }),
  ]);

  const wsList = extractList(wsResp, "workspaces");
  const paneList = extractList(paneResp, "panes");

  const workspaces: HerdrWorkspace[] = wsList.map((w) => {
    const ws = w as Record<string, unknown>;
    return {
      workspaceId: String(ws.workspace_id),
      number: Number(ws.number ?? 0),
      label: String(ws.label ?? ws.workspace_id),
      agentStatus: asStatus(ws.agent_status),
      focused: Boolean(ws.focused),
      paneCount: Number(ws.pane_count ?? 0),
      tabCount: Number(ws.tab_count ?? 0),
      activeTabId: String(ws.active_tab_id ?? ""),
    };
  });

  const panes: HerdrPane[] = paneList.map((p) => {
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
    };
  });

  workspaces.sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    return a.number - b.number;
  });

  return { workspaces, panes };
}

function errorMessage(response: HerdrResponse): string | null {
  if (!response.error) return null;
  const err = response.error as { message?: unknown };
  return typeof err.message === "string" ? err.message : JSON.stringify(response.error);
}

// herdr 上で workspace (と、あれば tab) をフォーカスする。
// pane 単位の focus はソケット API に ID 指定がないため tab までの粒度。
export async function focusHerdrTarget(
  workspaceId: string,
  tabId?: string,
): Promise<void> {
  const wsResp = await callHerdr({
    id: "focus-ws",
    method: "workspace.focus",
    params: { workspace_id: workspaceId },
  });
  const wsError = errorMessage(wsResp);
  if (wsError) throw new Error(`workspace.focus: ${wsError}`);

  if (!tabId) return;
  const tabResp = await callHerdr({
    id: "focus-tab",
    method: "tab.focus",
    params: { tab_id: tabId },
  });
  const tabError = errorMessage(tabResp);
  if (tabError) throw new Error(`tab.focus: ${tabError}`);
}
