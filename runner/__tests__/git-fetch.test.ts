import { describe, expect, it } from "vitest";
import type { CommandRunner, RunResult } from "../exec";
import { fetchOrigin } from "../git-fetch";

/** 手動で解決できる Promise を作るヘルパー */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** fetch の実行区間を手動ゲートで制御し、重なりを検出するフェイク */
class GatedCommands implements CommandRunner {
  calls: { cmd: string; args: string[]; cwd: string }[] = [];
  /** run が呼ばれるたびに shift して待つゲート。空なら即時解決 */
  gates: Promise<void>[] = [];
  active = 0;
  maxActive = 0;

  async run(
    cmd: string,
    args: string[],
    opts: { cwd: string },
  ): Promise<RunResult> {
    this.calls.push({ cmd, args, cwd: opts.cwd });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const gate = this.gates.shift();
    if (gate) await gate;
    this.active--;
    return { stdout: "", stderr: "" };
  }
}

describe("fetchOrigin", () => {
  it("repoDir を cwd として git fetch origin main を実行する", async () => {
    const commands = new GatedCommands();
    await fetchOrigin(commands, "/repo/single", "main");
    expect(commands.calls).toEqual([
      { cmd: "git", args: ["fetch", "origin", "main"], cwd: "/repo/single" },
    ]);
  });

  it("同一 repoDir への並行呼び出しは直列化され、実行区間が重ならない", async () => {
    const commands = new GatedCommands();
    const gate1 = deferred();
    const gate2 = deferred();
    commands.gates = [gate1.promise, gate2.promise];

    const first = fetchOrigin(commands, "/repo/serial", "main");
    const second = fetchOrigin(commands, "/repo/serial", "main");

    await tick();
    // 1 本目が実行中の間、2 本目の fetch は開始されない
    expect(commands.calls).toHaveLength(1);

    gate1.resolve();
    await tick();
    expect(commands.calls).toHaveLength(2);

    gate2.resolve();
    await Promise.all([first, second]);

    expect(commands.maxActive).toBe(1);
  });

  it("異なる repoDir への呼び出しは互いにブロックせず並行実行される", async () => {
    const commands = new GatedCommands();
    const gateA = deferred();
    const gateB = deferred();
    commands.gates = [gateA.promise, gateB.promise];

    const a = fetchOrigin(commands, "/repo/parallel-a", "main");
    const b = fetchOrigin(commands, "/repo/parallel-b", "main");

    await tick();
    // a が完了していなくても b の fetch は開始している
    expect(commands.calls).toHaveLength(2);
    expect(commands.maxActive).toBe(2);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([a, b]);
  });

  describe("ref lock 失敗時のリトライ", () => {
    /** 指定回数だけ指定エラーで失敗し、その後成功するフェイク */
    function failingCommands(failures: number, error: () => Error) {
      const calls: string[][] = [];
      let remaining = failures;
      const commands: CommandRunner = {
        async run(_cmd, args) {
          calls.push(args);
          if (remaining > 0) {
            remaining--;
            throw error();
          }
          return { stdout: "", stderr: "" };
        },
      };
      return { commands, calls };
    }

    /** 待機せず記録だけする sleep フェイク */
    function fakeSleep() {
      const waits: number[] = [];
      const sleep = async (ms: number) => {
        waits.push(ms);
      };
      return { sleep, waits };
    }

    it("cannot lock ref で 1 回失敗しても、リトライして成功すれば解決する", async () => {
      const { commands, calls } = failingCommands(
        1,
        () =>
          new Error(
            "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def",
          ),
      );
      const { sleep, waits } = fakeSleep();

      await expect(
        fetchOrigin(commands, "/repo/retry-once", "main", { sleep }),
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(2);
      expect(waits).toEqual([500]);
    });

    it("stderr プロパティに cannot lock ref を含むエラーもリトライ対象になる", async () => {
      const { commands, calls } = failingCommands(1, () => {
        const error = new Error("Command failed: git fetch origin main");
        Object.assign(error, {
          stderr: "error: cannot lock ref 'refs/remotes/origin/main'",
        });
        return error;
      });
      const { sleep } = fakeSleep();

      await expect(
        fetchOrigin(commands, "/repo/retry-stderr", "main", { sleep }),
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(2);
    });

    it("リトライ上限 (2 回) を超えて失敗し続けた場合は最後のエラーが伝播する", async () => {
      let count = 0;
      const { commands, calls } = failingCommands(Infinity, () => {
        count++;
        return new Error(
          `cannot lock ref 'refs/remotes/origin/main' (attempt ${count})`,
        );
      });
      const { sleep, waits } = fakeSleep();

      await expect(
        fetchOrigin(commands, "/repo/retry-exhausted", "main", { sleep }),
      ).rejects.toThrow("(attempt 3)");
      // 初回 + リトライ 2 回 = 3 回で打ち止め
      expect(calls).toHaveLength(3);
      expect(waits).toEqual([500, 500]);
    });

    it("cannot lock ref を含まない失敗はリトライせず即座に伝播する", async () => {
      const { commands, calls } = failingCommands(
        Infinity,
        () => new Error("fatal: could not read Username for 'https://github.com'"),
      );
      const { sleep, waits } = fakeSleep();

      await expect(
        fetchOrigin(commands, "/repo/no-retry", "main", { sleep }),
      ).rejects.toThrow("could not read Username");
      expect(calls).toHaveLength(1);
      expect(waits).toEqual([]);
    });
  });

  it("fetch が失敗しても後続の同一 repoDir の fetch は実行される", async () => {
    let failFirst = true;
    const calls: string[][] = [];
    const commands: CommandRunner = {
      async run(_cmd, args) {
        calls.push(args);
        if (failFirst) {
          failFirst = false;
          throw new Error("fetch failed");
        }
        return { stdout: "", stderr: "" };
      },
    };

    await expect(fetchOrigin(commands, "/repo/fail", "main")).rejects.toThrow(
      "fetch failed",
    );
    await expect(fetchOrigin(commands, "/repo/fail", "main")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});
