import { describe, expect, it } from "vitest";
import { KeyedMutex } from "../mutex";

/** 手動で解決できる Promise を作るヘルパー */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("KeyedMutex", () => {
  it("同一キーの処理は FIFO で 1 本ずつ実行され、実行区間が重ならない", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let running = 0;
    let maxRunning = 0;

    const gates = [deferred(), deferred(), deferred()];
    const tasks = [0, 1, 2].map((i) =>
      mutex.runExclusive("key", async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        events.push(`start:${i}`);
        await gates[i].promise;
        events.push(`end:${i}`);
        running--;
      }),
    );

    // 全ゲートを逆順で開けても、実行は呼び出し順で進む
    await tick();
    expect(events).toEqual(["start:0"]);

    gates[2].resolve();
    gates[1].resolve();
    await tick();
    // 0 が終わっていないので 1, 2 はまだ開始しない
    expect(events).toEqual(["start:0"]);

    gates[0].resolve();
    await Promise.all(tasks);

    expect(events).toEqual([
      "start:0",
      "end:0",
      "start:1",
      "end:1",
      "start:2",
      "end:2",
    ]);
    expect(maxRunning).toBe(1);
  });

  it("異なるキー同士は互いにブロックせず並行実行される", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const gateA = deferred();
    const gateB = deferred();

    const taskA = mutex.runExclusive("a", async () => {
      events.push("start:a");
      await gateA.promise;
      events.push("end:a");
    });
    const taskB = mutex.runExclusive("b", async () => {
      events.push("start:b");
      await gateB.promise;
      events.push("end:b");
    });

    await tick();
    // a が完了していなくても b は開始している（並行実行）
    expect(events).toEqual(["start:a", "start:b"]);

    gateB.resolve();
    gateA.resolve();
    await Promise.all([taskA, taskB]);
    expect(events).toEqual(["start:a", "start:b", "end:b", "end:a"]);
  });

  it("fn が reject してもロックが解放され、後続の同一キーの処理が実行される", async () => {
    const mutex = new KeyedMutex();

    const first = mutex.runExclusive("key", async () => {
      throw new Error("boom");
    });
    const second = mutex.runExclusive("key", async () => "second done");

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("second done");
  });

  it("fn が同期的に throw してもロックが解放される", async () => {
    const mutex = new KeyedMutex();

    const first = mutex.runExclusive("key", () => {
      throw new Error("sync boom");
    });
    const second = mutex.runExclusive("key", () => "ok");

    await expect(first).rejects.toThrow("sync boom");
    await expect(second).resolves.toBe("ok");
  });

  it("fn の戻り値を解決し、エラーをそのまま伝播する", async () => {
    const mutex = new KeyedMutex();

    await expect(mutex.runExclusive("key", async () => 42)).resolves.toBe(42);
    // 非 Promise の戻り値もそのまま解決される
    await expect(mutex.runExclusive("key", () => "sync value")).resolves.toBe(
      "sync value",
    );

    const error = new Error("original error");
    await expect(
      mutex.runExclusive("key", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
