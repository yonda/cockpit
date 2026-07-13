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
import { RepoRegistry, type RepoConfig } from "../repo-registry";

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
    (cwd: string, githubToken: string | null = "tok-acme"): DecomposeDeps["prepareCwd"] =>
    async (): Promise<PreparedCwd> => ({
      cwd,
      githubToken,
      cleanup: async () => {},
    });

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
          githubToken: "tok-acme",
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

  it("passes the resolved owner token from prepareCwd into the executor opts (not null)", async () => {
    const executor = new WritingExecutor(validTasks);
    const res = await runDecomposition(
      {
        executor,
        prepareCwd: fakePrepareCwd(scratch, "tok-acme"),
      },
      {
        repo: "acme/widgets",
        issueNumber: 5,
        title: "t",
        body: "b",
        signal: new AbortController().signal,
      },
    );
    expect(res.ok).toBe(true);
    expect(executor.lastOpts?.githubToken).toBe("tok-acme");
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

  const repoConfig: RepoConfig = {
    repo: "acme/widgets",
    path: "/repo",
    baseBranch: "main",
    tokenOwner: "acme",
  };
  const registry = () => new RepoRegistry([repoConfig]);
  const resolveToken = () => "test-token";

  it("adds a detached worktree (no branch) so revise/re-fire never collides", async () => {
    const commands = new FakeCommands();
    const prepare = realPrepareCwd(commands, registry(), resolveToken);

    const { cwd, githubToken } = await prepare("acme/widgets", 42);

    expect(cwd.endsWith("decomp/42")).toBe(true);
    expect(githubToken).toBe("test-token");
    const addCall = commands.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(addCall).toBeDefined();
    expect(addCall!.args).toContain("--detach");
    expect(addCall!.args).not.toContain("-b");
  });

  it("fetches origin/<baseBranch> in the repoDir before adding the worktree", async () => {
    const commands = new FakeCommands();
    const prepare = realPrepareCwd(commands, registry(), resolveToken);

    await prepare("acme/widgets", 42);

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

  it("throws a clear error when the repo is not registered", async () => {
    const commands = new FakeCommands();
    const prepare = realPrepareCwd(commands, new RepoRegistry([]), resolveToken);

    await expect(prepare("unknown/repo", 42)).rejects.toThrow(
      "repo-registry に未登録のリポジトリです",
    );
  });

  it("fails closed when resolveToken throws (does not proceed tokenless)", async () => {
    const commands = new FakeCommands();
    const failingResolveToken = (): string => {
      throw new Error("token file が見つかりません");
    };
    const prepare = realPrepareCwd(commands, registry(), failingResolveToken);

    await expect(prepare("acme/widgets", 42)).rejects.toThrow(
      "token file が見つかりません",
    );
    // worktree を作る前に fail-closed で止まっていること
    const addCall = commands.calls.find(
      (c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add",
    );
    expect(addCall).toBeUndefined();
  });
});
