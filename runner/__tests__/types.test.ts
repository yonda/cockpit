import { describe, expect, it } from "vitest";
import { canTransition, isPendingInputResponse } from "../../lib/jobs/types";

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

describe("isPendingInputResponse", () => {
  it("accepts allow", () => {
    expect(isPendingInputResponse({ kind: "allow" })).toBe(true);
  });

  it("accepts deny with message", () => {
    expect(isPendingInputResponse({ kind: "deny", message: "x" })).toBe(true);
  });

  it("accepts answers with string[][]", () => {
    expect(
      isPendingInputResponse({ kind: "answers", answers: [["a"]] }),
    ).toBe(true);
  });

  it("rejects empty object", () => {
    expect(isPendingInputResponse({})).toBe(false);
  });

  it("rejects null", () => {
    expect(isPendingInputResponse(null)).toBe(false);
  });

  it("rejects deny without message", () => {
    expect(isPendingInputResponse({ kind: "deny" })).toBe(false);
  });

  it("rejects answers with non-array answers", () => {
    expect(isPendingInputResponse({ kind: "answers", answers: "x" })).toBe(
      false,
    );
  });
});
