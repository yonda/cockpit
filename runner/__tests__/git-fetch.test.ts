import { describe, expect, it } from "vitest";
import type { CommandRunner, RunResult } from "../exec";
import { fetchOriginMain } from "../git-fetch";

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

describe("fetchOriginMain", () => {
  it("repoDir を cwd として git fetch origin main を実行する", async () => {
    const commands = new GatedCommands();
    await fetchOriginMain(commands, "/repo/single");
    expect(commands.calls).toEqual([
      { cmd: "git", args: ["fetch", "origin", "main"], cwd: "/repo/single" },
    ]);
  });

  it("同一 repoDir への並行呼び出しは直列化され、実行区間が重ならない", async () => {
    const commands = new GatedCommands();
    const gate1 = deferred();
    const gate2 = deferred();
    commands.gates = [gate1.promise, gate2.promise];

    const first = fetchOriginMain(commands, "/repo/serial");
    const second = fetchOriginMain(commands, "/repo/serial");

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

    const a = fetchOriginMain(commands, "/repo/parallel-a");
    const b = fetchOriginMain(commands, "/repo/parallel-b");

    await tick();
    // a が完了していなくても b の fetch は開始している
    expect(commands.calls).toHaveLength(2);
    expect(commands.maxActive).toBe(2);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([a, b]);
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

    await expect(fetchOriginMain(commands, "/repo/fail")).rejects.toThrow(
      "fetch failed",
    );
    await expect(fetchOriginMain(commands, "/repo/fail")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});
