import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { fetchHerdrState } from "./server";

const SOCKET_PATH =
  process.env.HERDR_SOCKET_PATH ?? `${homedir()}/.config/herdr/herdr.sock`;
const RECONCILE_DEBOUNCE_MS = 500;
const RECONCILE_MIN_INTERVAL_MS = 2_000;
const RECONCILE_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 1_000;

// herdr は 1 接続につき最初の subscribe 1 回しか受け付けない
// (2 回目を送るとイベント配信が止まる)。pane 単位の購読
// (pane.agent_status_changed) を含めるため、pane 構成が変わったら
// 接続ごと張り直す。
const GLOBAL_EVENT_TYPES = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "pane.created",
  "pane.closed",
  "pane.exited",
  "pane.focused",
  "pane.moved",
  "pane.agent_detected",
] as const;

const TOPOLOGY_EVENTS = new Set(["pane_created", "pane_closed", "pane_exited"]);

export type HerdrEvent = { event: string; data: unknown };

export function openHerdrEventStream({
  onEvent,
  onError,
  signal,
}: {
  onEvent: (event: HerdrEvent) => void;
  onError: (message: string) => void;
  signal: AbortSignal;
}): void {
  let socket: Socket | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastReconcileAt = 0;
  let subscribedPanes = new Set<string>();

  const closeSocket = () => {
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
  };

  // herdr は接続時に直近イベントの backlog をリプレイするため、イベントの
  // 中身 (とうに閉じた pane の pane_created 等) を再購読トリガーにすると
  // 再接続 → また backlog → 再購読 の無限ループになる。そこでイベントは
  // あくまで「照合のきっかけ」とし、pane.list (現実) と購読集合を比較して
  // ドリフトがあるときだけ張り直す。リプレイ由来のイベントはドリフトを
  // 生まないので再接続しない。
  const reconcile = async () => {
    if (signal.aborted || reconnectTimer) return;
    try {
      const state = await fetchHerdrState();
      const current = new Set(state.panes.map((p) => p.paneId));
      const drifted =
        current.size !== subscribedPanes.size ||
        [...current].some((id) => !subscribedPanes.has(id));
      if (drifted) void connect();
    } catch {
      // 一時的な取得失敗は次の照合機会に任せる
    }
  };

  const scheduleReconcile = () => {
    if (signal.aborted || reconcileTimer) return;
    const sinceLast = Date.now() - lastReconcileAt;
    const delay = Math.max(
      RECONCILE_DEBOUNCE_MS,
      RECONCILE_MIN_INTERVAL_MS - sinceLast,
    );
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      lastReconcileAt = Date.now();
      void reconcile();
    }, delay);
  };

  const periodicTimer = setInterval(scheduleReconcile, RECONCILE_INTERVAL_MS);

  const cleanup = () => {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearInterval(periodicTimer);
    closeSocket();
  };
  signal.addEventListener("abort", cleanup, { once: true });

  const scheduleReconnect = (reason: string) => {
    if (signal.aborted || reconnectTimer) return;
    onError(reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, RECONNECT_DELAY_MS);
  };

  async function connect(): Promise<void> {
    if (signal.aborted) return;
    closeSocket();

    let paneIds: string[] = [];
    try {
      const state = await fetchHerdrState();
      paneIds = state.panes.map((p) => p.paneId);
    } catch (err) {
      scheduleReconnect(
        err instanceof Error ? err.message : "failed to list panes",
      );
      return;
    }
    if (signal.aborted) return;

    subscribedPanes = new Set(paneIds);
    const subscriptions = [
      ...GLOBAL_EVENT_TYPES.map((type) => ({ type })),
      ...paneIds.map((pane_id) => ({
        type: "pane.agent_status_changed",
        pane_id,
      })),
    ];

    const sock = createConnection(SOCKET_PATH);
    socket = sock;
    let buffer = "";

    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({
          id: "sub",
          method: "events.subscribe",
          params: { subscriptions },
        })}\n`,
      );
    });

    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: { id?: string; error?: { message?: string }; event?: string; data?: unknown };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.error) {
          scheduleReconnect(parsed.error.message ?? "herdr subscribe error");
          return;
        }
        if (parsed.id === "sub") continue; // subscription ack
        if (!parsed.event) continue;
        onEvent({ event: parsed.event, data: parsed.data });
        if (TOPOLOGY_EVENTS.has(parsed.event)) {
          scheduleReconcile();
        }
      }
    });

    sock.on("error", (err) => {
      if (socket === sock) scheduleReconnect(err.message);
    });

    sock.on("close", () => {
      if (socket === sock && !signal.aborted) {
        scheduleReconnect("herdr socket closed");
      }
    });
  }

  void connect();
}
