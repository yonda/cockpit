import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentExecutor,
  ExecutorHooks,
  ExecutorRunOpts,
} from "../executor";
import type { CommandRunner, RunResult } from "../exec";
import type { SubTask } from "../../lib/pbi/types";
import {
  buildDecomposePrompt,
  runDecomposition,
  realPrepareCwd,
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

  it("fails when the agent emits an empty task array", async () => {
    const res = await runDecomposition(deps(new WritingExecutor([])), {
      repo: "r",
      issueNumber: 5,
      title: "t",
      body: "b",
      signal: new AbortController().signal,
    });
    expect(res.ok).toBe(false);
  });
});

describe("realPrepareCwd", () => {
  /** 呼び出しを記録するだけのフェイク CommandRunner（github.test.ts の FakeCommands と同じ形） */
  class FakeCommands implements CommandRunner {
    calls: { cmd: string; args: string[]; cwd: string }[] = [];
    async run(
      cmd: string,
      args: string[],
      opts: { cwd: string },
    ): Promise<RunResult> {
      this.calls.push({ cmd, args, cwd: opts.cwd });
      return { stdout: "", stderr: "" };
    }
  }

  it("adds a detached worktree (no branch) so revise/re-fire never collides", async () => {
    const commands = new FakeCommands();
    const prepare = realPrepareCwd(commands, "/repo");

    const { cwd } = await prepare(42);

    expect(cwd.endsWith("decomp/42")).toBe(true);
    const addCall = commands.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(addCall).toBeDefined();
    expect(addCall!.args).toContain("--detach");
    expect(addCall!.args).not.toContain("-b");
  });

  it("fetches origin/main in the repoDir before adding the worktree", async () => {
    const commands = new FakeCommands();
    const prepare = realPrepareCwd(commands, "/repo");

    await prepare(42);

    const fetchIndex = commands.calls.findIndex(
      (c) =>
        c.cmd === "git" &&
        c.args.join(" ") === "fetch origin main" &&
        c.cwd === "/repo",
    );
    const addIndex = commands.calls.findIndex(
      (c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(addIndex).toBeGreaterThan(fetchIndex);
  });
});
