import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  isPendingInputResponse,
  type Job,
  type RunnerRequest,
  type RunnerResponse,
} from "../lib/jobs/types";
import type { PbiJob, PbiRunnerRequest } from "../lib/pbi/types";
import type { InputBroker } from "./input-broker";
import { handlePbiRequest, type PbiServerDeps } from "./pbi-server";
import type { Scheduler } from "./scheduler";
import type { JobStore } from "./store";
import { buildBranchName } from "./workflow";

type Deps = {
  store: JobStore;
  scheduler: Scheduler;
  broker: InputBroker;
  pbi: PbiServerDeps;
};

const ACTIVE = new Set(["queued", "running", "waiting_input"]);

export function startRunnerServer(socketPath: string, deps: Deps): Server {
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) unlinkSync(socketPath); // 前回の残骸

  const subscribers = new Set<Socket>();
  deps.store.on("job", (job: Job) => {
    const line = `${JSON.stringify({ event: "job.updated", data: job })}\n`;
    for (const socket of subscribers) socket.write(line);
  });
  deps.pbi.pbiStore.on("pbi", (pbi: PbiJob) => {
    const line = `${JSON.stringify({ event: "pbi.updated", data: pbi })}\n`;
    for (const socket of subscribers) socket.write(line);
  });

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        handleLine(line, socket, subscribers, deps);
      }
    });
    const drop = () => subscribers.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  server.listen(socketPath);
  return server;
}

function respond(socket: Socket, response: RunnerResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function handleLine(
  line: string,
  socket: Socket,
  subscribers: Set<Socket>,
  deps: Deps,
): void {
  let request: RunnerRequest | PbiRunnerRequest;
  try {
    request = JSON.parse(line) as RunnerRequest | PbiRunnerRequest;
  } catch {
    respond(socket, { id: "?", error: { message: "invalid json" } });
    return;
  }

  if (request.method.startsWith("pbi.")) {
    void handlePbiRequest(request as PbiRunnerRequest, deps.pbi).then((r) =>
      respond(socket, { id: request.id, ...r }),
    );
    return;
  }

  try {
    switch (request.method) {
      case "job.list":
        respond(socket, { id: request.id, result: { jobs: deps.store.list() } });
        return;

      case "job.fire": {
        const { repo, issueNumber, issueTitle } = request.params;
        const duplicate = deps.store
          .list()
          .find(
            (j) =>
              j.repo === repo &&
              j.issueNumber === issueNumber &&
              ACTIVE.has(j.status),
          );
        if (duplicate) {
          respond(socket, {
            id: request.id,
            error: { message: `issue #${issueNumber} is already active (${duplicate.id})` },
          });
          return;
        }
        const job = deps.store.create({
          repo,
          issueNumber,
          issueTitle,
          branch: buildBranchName(issueNumber, issueTitle),
        });
        deps.scheduler.poke();
        respond(socket, { id: request.id, result: { job } });
        return;
      }

      case "job.cancel":
        deps.scheduler.cancel(request.params.jobId);
        respond(socket, { id: request.id, result: {} });
        return;

      case "job.respond": {
        const { jobId, inputId, response } = request.params as {
          jobId: string;
          inputId: string;
          response: unknown;
        };
        if (!isPendingInputResponse(response)) {
          respond(socket, {
            id: request.id,
            error: { message: "invalid response shape" },
          });
          return;
        }
        const ok = deps.broker.resolve(jobId, inputId, response);
        if (!ok) {
          respond(socket, {
            id: request.id,
            error: { message: "no matching pending input" },
          });
          return;
        }
        respond(socket, { id: request.id, result: {} });
        return;
      }

      case "events.subscribe":
        subscribers.add(socket);
        respond(socket, { id: request.id, result: { subscribed: true } });
        return;

      default:
        respond(socket, {
          id: (request as { id?: string }).id ?? "?",
          error: { message: "unknown method" },
        });
    }
  } catch (err) {
    respond(socket, {
      id: request.id,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }
}
