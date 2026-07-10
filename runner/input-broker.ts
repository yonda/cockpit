import type { PendingInput, PendingInputResponse } from "../lib/jobs/types";

type Pending = {
  inputId: string;
  resolve: (response: PendingInputResponse) => void;
};

/** canUseTool の Promise を保留し、UI からの回答で解決する受付台 */
export class InputBroker {
  private pending = new Map<string, Pending>();

  request(jobId: string, input: PendingInput): Promise<PendingInputResponse> {
    return new Promise((resolve) => {
      this.pending.set(jobId, { inputId: input.id, resolve });
    });
  }

  resolve(
    jobId: string,
    inputId: string,
    response: PendingInputResponse,
  ): boolean {
    const entry = this.pending.get(jobId);
    if (!entry || entry.inputId !== inputId) return false;
    this.pending.delete(jobId);
    entry.resolve(response);
    return true;
  }

  abort(jobId: string): void {
    const entry = this.pending.get(jobId);
    if (!entry) return;
    this.pending.delete(jobId);
    entry.resolve({ kind: "deny", message: "job cancelled" });
  }
}
