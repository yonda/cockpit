import { describe, expect, it } from "vitest";
import { RealCommandRunner } from "../exec";

describe("RealCommandRunner env override", () => {
  it("opts.env が子プロセスに渡り process.env にマージされる", async () => {
    const runner = new RealCommandRunner();
    const { stdout } = await runner.run(
      "sh",
      ["-c", "echo $COCKPIT_TEST_VAR"],
      { cwd: process.cwd(), env: { COCKPIT_TEST_VAR: "hello" } },
    );
    expect(stdout.trim()).toBe("hello");
  });

  it("env 未指定でも従来どおり動く", async () => {
    const runner = new RealCommandRunner();
    const { stdout } = await runner.run("echo", ["ok"], { cwd: process.cwd() });
    expect(stdout.trim()).toBe("ok");
  });
});
