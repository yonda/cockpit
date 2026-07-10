import { describe, expect, it } from "vitest";
import { canTransition } from "../../lib/jobs/types";

describe("canTransition", () => {
  it("allows the happy path", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "waiting_input")).toBe(true);
    expect(canTransition("waiting_input", "running")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
  });

  it("rejects transitions out of terminal states", () => {
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("failed", "queued")).toBe(false);
    expect(canTransition("cancelled", "running")).toBe(false);
  });

  it("rejects skipping queued -> done", () => {
    expect(canTransition("queued", "done")).toBe(false);
  });
});
