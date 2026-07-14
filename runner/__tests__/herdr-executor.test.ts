import { describe, expect, it, vi } from "vitest";
import type { ExecutorHooks, ExecutorRunOpts } from "../executor";
import {
  extractActivity,
  HerdrExecutor,
  type HerdrClient,
  type HerdrExecutorDeps,
  type TranscriptReader,
} from "../herdr-executor";

function makeHooks(): ExecutorHooks & {
  sessionIds: string[];
  activities: string[];
} {
  const sessionIds: string[] = [];
  const activities: string[] = [];
  return {
    sessionIds,
    activities,
    onSessionId: (s) => sessionIds.push(s),
    onActivity: (t) => activities.push(t),
    requestInput: vi.fn(async () => {
      throw new Error("requestInput must not be called in this slice");
    }),
  };
}

function makeOpts(overrides: Partial<ExecutorRunOpts> = {}): ExecutorRunOpts {
  return {
    cwd: "/wt/job",
    prompt: "implement issue #1",
    resumeSessionId: null,
    githubToken: null,
    repo: "yonda/cockpit",
    issueNumber: 1,
    issueTitle: "implement issue #1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

type Fakes = {
  herdr: HerdrClient & {
    createCalls: Array<{ workspaceId: string; label: string }>;
    startCalls: Array<Parameters<HerdrClient["startAgent"]>[1]>;
    closed: string[];
    statusCalls: string[];
  };
  transcript: TranscriptReader;
};

function makeFakes(opts: {
  session?: { path: string; sessionId: string } | null;
  activitiesPerRead?: string[][];
  done?: boolean;
  agentStatus?: string;
}): Fakes {
  const createCalls: Fakes["herdr"]["createCalls"] = [];
  const startCalls: Fakes["herdr"]["startCalls"] = [];
  const closed: string[] = [];
  const statusCalls: string[] = [];
  const reads = opts.activitiesPerRead ?? [["tool: Bash"]];
  let readIdx = 0;
  let offset = 0;

  const herdr: Fakes["herdr"] = {
    createCalls,
    startCalls,
    closed,
    statusCalls,
    createPane: async (o) => {
      createCalls.push(o);
      return "w1:p2";
    },
    startAgent: async (_pane, o) => {
      startCalls.push(o);
    },
    // done:false は「done へ達しない」を表す。false を即返すと張り直しループが
    // 空回りするため、未解決のまま留めて idle timeout 側の判定を検証させる。
    waitDone: async () =>
      opts.done === false ? new Promise<boolean>(() => {}) : true,
    agentStatus: async (p) => {
      statusCalls.push(p);
      return opts.agentStatus ?? "running";
    },
    closePane: async (p) => {
      closed.push(p);
    },
  };

  const transcript: TranscriptReader = {
    waitForSession: async () =>
      opts.session === undefined
        ? { path: "/tr/s.jsonl", sessionId: "sess-1" }
        : opts.session,
    readActivitySince: async () => {
      const activities = reads[readIdx] ?? [];
      readIdx += 1;
      offset += activities.length;
      return { activities, nextOffset: offset };
    },
  };

  return { herdr, transcript };
}

function makeDeps(fakes: Fakes, over: Partial<HerdrExecutorDeps> = {}) {
  return {
    herdr: fakes.herdr,
    transcript: fakes.transcript,
    trustWorktree: vi.fn(async () => {}),
    verifyProfile: vi.fn(),
    workspaceId: "w1",
    pollIntervalMs: 1,
    sessionTimeoutMs: 100,
    idleTimeoutMs: 100,
    ...over,
  } as HerdrExecutorDeps & { trustWorktree: ReturnType<typeof vi.fn> };
}

describe("extractActivity", () => {
  it("text ブロックは先頭 200 字", () => {
    const line = {
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(300) }] },
    };
    expect(extractActivity(line)).toBe("x".repeat(200));
  });

  it("tool_use は tool: 名前", () => {
    const line = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    };
    expect(extractActivity(line)).toBe("tool: Bash");
  });

  it("thinking / 非 assistant は null", () => {
    expect(
      extractActivity({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "..." }] },
      }),
    ).toBeNull();
    expect(extractActivity({ type: "system" })).toBeNull();
    expect(extractActivity(null)).toBeNull();
  });
});

describe("HerdrExecutor.run", () => {
  it("spawn→session_id→activity→done で ok を返す", async () => {
    const fakes = makeFakes({ activitiesPerRead: [["tool: Bash", "考え中"]] });
    const deps = makeDeps(fakes);
    const hooks = makeHooks();
    const exec = new HerdrExecutor(deps);

    const result = await exec.run(makeOpts(), hooks);

    expect(result).toEqual({ ok: true });
    expect(deps.trustWorktree).toHaveBeenCalledWith("/wt/job");
    expect(fakes.herdr.createCalls).toHaveLength(1);
    expect(hooks.sessionIds).toEqual(["sess-1"]);
    expect(hooks.activities).toContain("tool: Bash");
    // 後片付けでペインを閉じる
    expect(fakes.herdr.closed).toContain("w1:p2");
  });

  it("resumeSessionId を startAgent に渡す", async () => {
    const fakes = makeFakes({});
    const exec = new HerdrExecutor(makeDeps(fakes));
    await exec.run(makeOpts({ resumeSessionId: "prev-sid" }), makeHooks());
    expect(fakes.herdr.startCalls[0].resumeSessionId).toBe("prev-sid");
    expect(fakes.herdr.startCalls[0].prompt).toBe("implement issue #1");
  });

  it("githubToken を startAgent に渡す", async () => {
    const fakes = makeFakes({});
    const exec = new HerdrExecutor(makeDeps(fakes));
    await exec.run(makeOpts({ githubToken: "tok-xyz" }), makeHooks());
    expect(fakes.herdr.startCalls[0].githubToken).toBe("tok-xyz");
  });

  it("resume 時は履歴分を priming で読み飛ばし再生しない", async () => {
    // 1 回目の read (priming) が履歴、2 回目以降が新規 activity。
    const fakes = makeFakes({
      activitiesPerRead: [["履歴A", "履歴B"], ["新規C"]],
    });
    const hooks = makeHooks();
    const exec = new HerdrExecutor(makeDeps(fakes));
    await exec.run(makeOpts({ resumeSessionId: "prev" }), hooks);
    // priming で読んだ履歴は onActivity に流さない
    expect(hooks.activities).not.toContain("履歴A");
    expect(hooks.activities).toContain("新規C");
  });

  it("waitDone が reject したら error として返す (無限ループしない)", async () => {
    const fakes = makeFakes({});
    fakes.herdr.waitDone = async () => {
      throw new Error("herdr not found");
    };
    const exec = new HerdrExecutor(makeDeps(fakes));
    const result = await exec.run(makeOpts(), makeHooks());
    expect(result).toEqual({ ok: false, error: "herdr not found" });
  });

  it("transcript が現れなければ error・調査のためペインは残す", async () => {
    const fakes = makeFakes({ session: null });
    const exec = new HerdrExecutor(makeDeps(fakes));
    const result = await exec.run(makeOpts(), makeHooks());
    expect(result.ok).toBe(false);
    expect(fakes.herdr.closed).not.toContain("w1:p2"); // 失敗は残す
  });

  it("transcript の進行が止まって idle timeout を超えたら error・ペインは残す", async () => {
    // 1 回目の read で進行した後は追記なし → idle timeout 経路に入る。
    const fakes = makeFakes({ done: false, activitiesPerRead: [["tool: Bash"]] });
    const exec = new HerdrExecutor(makeDeps(fakes, { idleTimeoutMs: 30 }));
    const result = await exec.run(makeOpts(), makeHooks());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("idle timeout");
    // timeout 確定の直前に agent_status を再確認している (done でないので失敗確定)
    expect(fakes.herdr.statusCalls).toContain("w1:p2");
    expect(fakes.herdr.closed).not.toContain("w1:p2"); // 調査のため残す
  });

  it("transcript が進行し続ける限り waitDone の窓 timeout を跨いでも failed にならない", async () => {
    // fake clock: now() 呼び出しごとに 10 分進む。実装既定と同じ 30 分の
    // idleTimeoutMs でも、追記が続く限り総経過 (数時間相当) では timeout しない。
    let fakeMs = 0;
    const now = () => (fakeMs += 10 * 60_000);
    const closed: string[] = [];
    let waitDoneCalls = 0;
    const herdr: HerdrClient = {
      createPane: async () => "w1:p2",
      startAgent: async () => {},
      // 2 回は窓 timeout (false → 張り直し)。旧実装の固定 doneTimeout なら
      // 1 回目の false で failed になっていた経路。3 回目で done に達する。
      waitDone: async () => {
        waitDoneCalls += 1;
        if (waitDoneCalls < 3) return false;
        await new Promise((r) => setTimeout(r, 30));
        return true;
      },
      agentStatus: async () => "running",
      closePane: async (p) => {
        closed.push(p);
      },
    };
    let n = 0;
    const transcript: TranscriptReader = {
      waitForSession: async () => ({ path: "/tr/s.jsonl", sessionId: "sess-1" }),
      // 毎回追記あり = 進行が続いている
      readActivitySince: async (_p, from) => ({
        activities: [`act-${(n += 1)}`],
        nextOffset: from + 1,
      }),
    };
    const exec = new HerdrExecutor(
      makeDeps(makeFakes({}), {
        herdr,
        transcript,
        now,
        idleTimeoutMs: 30 * 60_000,
      }),
    );
    const result = await exec.run(makeOpts(), makeHooks());
    expect(result).toEqual({ ok: true });
    expect(waitDoneCalls).toBe(3);
    expect(fakeMs).toBeGreaterThan(30 * 60_000); // 経過は従来の 30 分を大きく超える
    expect(closed).toContain("w1:p2"); // 成功なのでペインを閉じる
  });

  it("idle timeout 確定の直前に agent_status が done なら成功として扱う", async () => {
    // waitDone は done を報せず、transcript も進まないが、実際には done 済みのケース。
    const fakes = makeFakes({
      done: false,
      activitiesPerRead: [[]],
      agentStatus: "done",
    });
    const exec = new HerdrExecutor(makeDeps(fakes, { idleTimeoutMs: 20 }));
    const result = await exec.run(makeOpts(), makeHooks());
    expect(result).toEqual({ ok: true });
    expect(fakes.herdr.statusCalls).toContain("w1:p2");
    expect(fakes.herdr.closed).toContain("w1:p2"); // 成功なのでペインを閉じる
  });

  it("開始前に abort 済みなら起動せず error・ペインを閉じる", async () => {
    const fakes = makeFakes({});
    const controller = new AbortController();
    controller.abort();
    const exec = new HerdrExecutor(makeDeps(fakes));
    const result = await exec.run(
      makeOpts({ signal: controller.signal }),
      makeHooks(),
    );
    expect(result.ok).toBe(false);
    expect(fakes.herdr.startCalls).toHaveLength(0);
    expect(fakes.herdr.closed).toContain("w1:p2");
  });

  it("verifyProfile が throw したら spawn せず error (統一プロファイル違反の fail-closed)", async () => {
    const fakes = makeFakes({});
    const exec = new HerdrExecutor(
      makeDeps(fakes, {
        verifyProfile: () => {
          throw new Error("統一プロファイル違反");
        },
      }),
    );
    const result = await exec.run(makeOpts({}), makeHooks());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("統一プロファイル違反");
    expect(fakes.herdr.startCalls).toHaveLength(0);
  });
});
