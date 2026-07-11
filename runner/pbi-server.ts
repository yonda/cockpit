// runner/pbi-server.ts
import type { PbiRunnerRequest } from "../lib/pbi/types";
import type { PbiStore } from "./pbi-store";
import {
  approveDecomposition,
  rejectDecomposition,
  reviseDecomposition,
  startDecomposition,
  type LifecycleDeps,
} from "./pbi-lifecycle";
import {
  cancelPbi,
  pausePbi,
  resumePbi,
  retryTask,
  skipTask,
} from "./pbi-actions";
import { dispatchReady, type PbiExecutorDeps } from "./pbi-executor";

export type PbiServerDeps = {
  pbiStore: PbiStore;
  lifecycle: LifecycleDeps;
  exec: PbiExecutorDeps;
};

export async function handlePbiRequest(
  request: PbiRunnerRequest,
  deps: PbiServerDeps,
): Promise<{ result?: unknown; error?: { message: string } }> {
  switch (request.method) {
    case "pbi.list":
      return { result: { pbis: deps.pbiStore.list() } };

    case "pbi.fire": {
      const { repo, issueNumber, title } = request.params;
      const duplicate = deps.pbiStore
        .list()
        .find(
          (p) =>
            p.repo === repo &&
            p.issueNumber === issueNumber &&
            !["completed", "failed", "cancelled"].includes(p.status),
        );
      if (duplicate) {
        return { error: { message: `PBI #${issueNumber} は既に進行中です` } };
      }
      const pbi = deps.pbiStore.create({ repo, issueNumber, title });
      // 分解は fire-and-forget（即応答し、進捗は pbi.updated で届く）
      void startDecomposition(
        deps.lifecycle,
        pbi.id,
        new AbortController().signal,
      );
      return { result: { pbi } };
    }

    case "pbi.approve":
      void approveDecomposition(deps.lifecycle, request.params.pbiId).then(
        () => dispatchReady(deps.exec, request.params.pbiId),
      );
      return { result: {} };

    case "pbi.revise":
      void reviseDecomposition(
        deps.lifecycle,
        request.params.pbiId,
        request.params.feedback,
        new AbortController().signal,
      );
      return { result: {} };

    case "pbi.reject":
      await rejectDecomposition(deps.lifecycle, request.params.pbiId);
      return { result: {} };

    case "pbi.pause":
      pausePbi(deps.pbiStore, request.params.pbiId);
      return { result: {} };

    case "pbi.resume":
      resumePbi(deps.exec, request.params.pbiId);
      return { result: {} };

    case "pbi.retryTask":
      retryTask(deps.exec, request.params.pbiId, request.params.key);
      return { result: {} };

    case "pbi.skipTask":
      skipTask(deps.exec, request.params.pbiId, request.params.key);
      return { result: {} };

    case "pbi.cancel":
      cancelPbi(deps.exec, request.params.pbiId);
      return { result: {} };

    default:
      return { error: { message: "unknown pbi method" } };
  }
}
