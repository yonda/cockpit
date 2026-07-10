import { describe, expect, it } from "vitest";
import { InputBroker } from "../input-broker";
import type { PendingInput } from "../../lib/jobs/types";

const input: PendingInput = {
  id: "in-1",
  kind: "permission",
  toolName: "Bash",
  input: { command: "rm -rf node_modules" },
  createdAt: new Date().toISOString(),
};

describe("InputBroker", () => {
  it("resolves a pending request with the matching inputId", async () => {
    const broker = new InputBroker();
    const promise = broker.request("job-1", input);
    expect(broker.resolve("job-1", "in-1", { kind: "allow" })).toBe(true);
    await expect(promise).resolves.toEqual({ kind: "allow" });
  });

  it("ignores mismatched inputId", () => {
    const broker = new InputBroker();
    void broker.request("job-1", input);
    expect(broker.resolve("job-1", "in-999", { kind: "allow" })).toBe(false);
  });

  it("abort denies the pending request", async () => {
    const broker = new InputBroker();
    const promise = broker.request("job-1", input);
    broker.abort("job-1");
    await expect(promise).resolves.toEqual({
      kind: "deny",
      message: "job cancelled",
    });
  });
});
