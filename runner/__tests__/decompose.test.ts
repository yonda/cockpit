import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentExecutor,
  ExecutorHooks,
  ExecutorRunOpts,
} from "../executor";
import type { SubTask } from "../../lib/pbi/types";
import {
  buildDecomposePrompt,
  runDecomposition,
  type DecomposeDeps,
  type PreparedCwd,
} from "../decompose";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "decomp-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** decomposition.json を書いてから ok を返すフェイクエージェント */
class WritingExecutor implements AgentExecutor {
  constructor(private readonly payload: unknown) {}
  lastOpts: ExecutorRunOpts | null = null;
  async run(opts: ExecutorRunOpts, _hooks: ExecutorHooks) {
    this.lastOpts = opts;
    writeFileSync(
      join(opts.cwd, "decomposition.json"),
      JSON.stringify(this.payload),
    );
    return { ok: true as const };
  }
}

const validTasks: SubTask[] = [
  {
    key: "t1",
    title: "types",
    goal: "土台",
    deliverable: "types.ts",
    acceptanceCriteria: ["ok"],
    dependsOn: [],
  },
];

describe("buildDecomposePrompt", () => {
  it("includes prior tasks and feedback on a revise", () => {
    const p = buildDecomposePrompt({
      issueNumber: 5,
      title: "t",
      body: "b",
      priorTasks: validTasks,
      feedback: "t1 が大きすぎる",
    });
    expect(p).toContain("t1 が大きすぎる");
    expect(p).toContain("types.ts");
  });
});

describe("runDecomposition", () => {
  const fakePrepareCwd =
    (cwd: string): DecomposeDeps["prepareCwd"] =>
    async (): Promise<PreparedCwd> => ({ cwd, cleanup: async () => {} });

  const deps = (executor: AgentExecutor): DecomposeDeps => ({
    executor,
    prepareCwd: fakePrepareCwd(scratch),
  });

  it("returns validated tasks written by the agent", async () => {
    const res = await runDecomposition(deps(new WritingExecutor(validTasks)), {
      repo: "yonda/cockpit",
      issueNumber: 5,
      title: "t",
      body: "b",
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ ok: true, tasks: validTasks });
  });

  it("fails when the artifact is missing", async () => {
    const empty: AgentExecutor = { run: async () => ({ ok: true }) };
    const res = await runDecomposition(deps(empty), {
      repo: "r",
      issueNumber: 5,
      title: "t",
      body: "b",
      signal: new AbortController().signal,
    });
    expect(res.ok).toBe(false);
  });

  it("fails when the artifact fails schema validation", async () => {
    const res = await runDecomposition(
      deps(new WritingExecutor([{ key: "t1" }])),
      {
        repo: "r",
        issueNumber: 5,
        title: "t",
        body: "b",
        signal: new AbortController().signal,
      },
    );
    expect(res.ok).toBe(false);
  });

  it("fails when the executor reports an error", async () => {
    const boom: AgentExecutor = {
      run: async () => ({ ok: false, error: "sdk down" }),
    };
    const res = await runDecomposition(deps(boom), {
      repo: "r",
      issueNumber: 5,
      title: "t",
      body: "b",
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ ok: false, error: "sdk down" });
  });

  it("calls cleanup even when the executor errors", async () => {
    let cleanedUp = false;
    const boom: AgentExecutor = {
      run: async () => ({ ok: false, error: "sdk down" }),
    };
    const res = await runDecomposition(
      {
        executor: boom,
        prepareCwd: async () => ({
          cwd: scratch,
          cleanup: async () => {
            cleanedUp = true;
          },
        }),
      },
      {
        repo: "r",
        issueNumber: 5,
        title: "t",
        body: "b",
        signal: new AbortController().signal,
      },
    );
    expect(res.ok).toBe(false);
    expect(cleanedUp).toBe(true);
  });
});
