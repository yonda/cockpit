import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import type {
  RunnerEvent,
  RunnerRequest,
  RunnerResponse,
} from "@/lib/jobs/types";
import type { PbiRunnerEvent, PbiRunnerRequest } from "@/lib/pbi/types";
import type { ReposRunnerRequest } from "@/lib/repos/types";

const REQUEST_TIMEOUT_MS = 5_000;
const RECONNECT_DELAY_MS = 1_000;

function getSocketPath(): string {
  return (
    process.env.RUNNER_SOCKET_PATH ??
    join(homedir(), ".cache", "cockpit", "runner.sock")
  );
}

export async function callRunner<T>(
  method:
    | RunnerRequest["method"]
    | PbiRunnerRequest["method"]
    | ReposRunnerRequest["method"],
  params: unknown,
): Promise<T> {
  const socketPath = getSocketPath();
  const request = {
    id: `req-${Math.random().toString(36).slice(2, 10)}`,
    method,
    params,
  };
  const response = await new Promise<RunnerResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      settle(() => {
        socket.destroy();
        reject(new Error(`runner socket timeout after ${REQUEST_TIMEOUT_MS}ms`));
      });
    }, REQUEST_TIMEOUT_MS);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as RunnerResponse;
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
    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("close", () =>
      settle(() => reject(new Error("runner socket closed before responding"))),
    );
  });

  if (response.error) throw new Error(response.error.message);
  return response.result as T;
}

export function openRunnerEventStream({
  signal,
  onEvent,
  onError,
}: {
  signal: AbortSignal;
  onEvent: (event: RunnerEvent | PbiRunnerEvent) => void;
  onError: (message: string) => void;
}): void {
  let socket: Socket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const closeSocket = () => {
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
  };

  const cleanup = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    closeSocket();
  };
  signal.addEventListener("abort", cleanup, { once: true });

  const scheduleReconnect = (reason: string) => {
    if (signal.aborted || reconnectTimer) return;
    onError(reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  };

  function connect(): void {
    if (signal.aborted) return;
    closeSocket();
    const socketPath = getSocketPath();
    const sock = createConnection(socketPath);
    socket = sock;
    let buffer = "";

    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({ id: "sub", method: "events.subscribe", params: {} })}\n`,
      );
    });
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: { id?: string; event?: string; data?: unknown };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id === "sub") continue; // subscription ack
        if (parsed.event === "job.updated") {
          onEvent(parsed as RunnerEvent);
        } else if (parsed.event === "pbi.updated") {
          onEvent(parsed as PbiRunnerEvent);
        }
      }
    });
    sock.on("error", (err) => {
      if (socket === sock) scheduleReconnect(err.message);
    });
    sock.on("close", () => {
      if (socket === sock && !signal.aborted) {
        scheduleReconnect("runner socket closed");
      }
    });
  }

  connect();
}
