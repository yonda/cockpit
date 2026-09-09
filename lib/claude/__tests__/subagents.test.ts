import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseMeta,
  parseTail,
  readSubagentsDir,
  resolveStatus,
  sortSubagents,
  STALE_AFTER_MS,
  subagentsDirFor,
  summarizeSubagents,
  type SubagentInfo,
} from "../subagents";

const line = (obj: unknown) => JSON.stringify(obj);
// 実際の transcript と同じく、1 ターンの thinking / text / tool_use は別行に書かれ、
// stop_reason は最終応答の行だけ "end_turn" になる (途中は "tool_use" か null)
const assistant = (blocks: unknown[], stopReason: string | null = null) =>
  line({
    type: "assistant",
    message: { role: "assistant", content: blocks, stop_reason: stopReason },
  });
const user = (blocks: unknown[]) =>
  line({ type: "user", message: { role: "user", content: blocks } });
const hook = (hookEvent: string) =>
  line({ type: "attachment", attachment: { type: "hook_success", hookEvent } });

describe("parseTail", () => {
  it("末尾に SubagentStop の記録があれば終了", () => {
    const tail = [assistant([{ type: "text", text: "調べ終わりました" }]), hook("SubagentStop")].join(
      "\n",
    );
    const parsed = parseTail(tail);
    expect(parsed.endedByHook).toBe(true);
    expect(parsed.lastMessage).toBe("調べ終わりました");
  });

  it("SubagentStop の後に再開して本文が続けば動作中 (途中の Stop は数えない)", () => {
    const tail = [
      assistant([{ type: "text", text: "一度終わり" }], "end_turn"),
      hook("SubagentStop"),
      user([{ type: "text", text: "続きをやって" }]),
      hook("SubagentStart"),
      assistant([{ type: "tool_use", id: "t", name: "Bash", input: {} }], "tool_use"),
    ].join("\n");
    const parsed = parseTail(tail);
    expect(parsed.endedByHook).toBe(false);
    expect(parsed.finalAnswer).toBe(false);
  });

  it("stop_reason=end_turn の assistant で終わっていれば最終応答 (hook 記録が無くても終了扱い)", () => {
    const tail = [
      user([{ type: "tool_result", tool_use_id: "x", content: "ok" }]),
      assistant([{ type: "text", text: "結論: A" }], "end_turn"),
    ].join("\n");
    const parsed = parseTail(tail);
    expect(parsed.endedByHook).toBe(false);
    expect(parsed.finalAnswer).toBe(true);
  });

  it("thinking / text だけの行で終わっていても、end_turn でなければ動作中 (tool_use 行が続く途中)", () => {
    expect(parseTail(assistant([{ type: "thinking", thinking: "..." }], "tool_use")).finalAnswer).toBe(
      false,
    );
    expect(parseTail(assistant([{ type: "text", text: "調べます" }], null)).finalAnswer).toBe(false);
  });

  it("assistant が tool_use で終わっていれば動作中 (後ろに別の hook 記録があっても)", () => {
    const tail = [
      assistant([{ type: "text", text: "調べます" }], "tool_use"),
      assistant([{ type: "tool_use", id: "t", name: "Bash", input: {} }], "tool_use"),
      hook("PostToolUse"),
    ].join("\n");
    const parsed = parseTail(tail);
    expect(parsed.finalAnswer).toBe(false);
    expect(parsed.endedByHook).toBe(false);
    expect(parsed.lastMessage).toBe("調べます");
  });

  it("tool_result で終わっていれば動作中。壊れた行は無視する", () => {
    const tail = [
      assistant([{ type: "text", text: "x" }], "end_turn"),
      "{not json",
      user([{ type: "tool_result", tool_use_id: "t", content: "..." }]),
    ].join("\n");
    expect(parseTail(tail).finalAnswer).toBe(false);
  });

  it("lastMessage は 1 行に潰して 200 文字で切る", () => {
    const long = "あ".repeat(300);
    const parsed = parseTail(assistant([{ type: "text", text: `x\n\n  ${long}` }]));
    expect(parsed.lastMessage?.startsWith("x あ")).toBe(true);
    expect(parsed.lastMessage?.endsWith("…")).toBe(true);
    expect(parsed.lastMessage?.length).toBe(201);
  });
});

describe("resolveStatus", () => {
  const base = { endedByHook: false, finalAnswer: false, lastMessage: null };
  it("終了の印があれば done、無ければ更新時刻で running / stale", () => {
    const now = 1_000_000_000_000;
    expect(resolveStatus({ ...base, endedByHook: true }, now - STALE_AFTER_MS * 2, now)).toBe(
      "done",
    );
    expect(resolveStatus({ ...base, finalAnswer: true }, now, now)).toBe("done");
    expect(resolveStatus(base, now - 1000, now)).toBe("running");
    expect(resolveStatus(base, now - STALE_AFTER_MS - 1, now)).toBe("stale");
  });
});

describe("parseMeta", () => {
  it("meta.json の項目を取り出し、欠けは既定値にする", () => {
    expect(
      parseMeta(
        '{"agentType":"general-purpose","description":"/code-review medium","name":"code-review","spawnDepth":1}',
      ),
    ).toEqual({
      agentType: "general-purpose",
      name: "code-review",
      description: "/code-review medium",
      spawnDepth: 1,
    });
    expect(parseMeta("{}")).toEqual({
      agentType: "agent",
      name: null,
      description: null,
      spawnDepth: 1,
    });
    expect(parseMeta("nope")).toBeNull();
  });
});

describe("sortSubagents / summarizeSubagents", () => {
  const info = (agentId: string, status: SubagentInfo["status"], updatedAt: string): SubagentInfo => ({
    agentId,
    agentType: "general-purpose",
    name: null,
    description: null,
    spawnDepth: 1,
    status,
    lastMessage: null,
    updatedAt,
  });

  it("running → done → stale の順、同じ状態は新しい順", () => {
    const sorted = sortSubagents([
      info("d-old", "done", "2026-09-09T00:00:00Z"),
      info("s", "stale", "2026-09-09T05:00:00Z"),
      info("r", "running", "2026-09-09T01:00:00Z"),
      info("d-new", "done", "2026-09-09T02:00:00Z"),
    ]);
    expect(sorted.map((s) => s.agentId)).toEqual(["r", "d-new", "d-old", "s"]);
    expect(summarizeSubagents(sorted)).toEqual({ running: 1, total: 4 });
  });
});

describe("subagentsDirFor", () => {
  it("transcript のパスから subagents ディレクトリを導く", () => {
    expect(subagentsDirFor("/p/-Users-x/abc.jsonl")).toBe("/p/-Users-x/abc/subagents");
  });
});

describe("readSubagentsDir", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("ディレクトリが無ければ空", async () => {
    expect(await readSubagentsDir("/nonexistent/subagents")).toEqual([]);
  });

  it("jsonl と meta.json を組にして状態付きで返す", async () => {
    dir = mkdtempSync(join(tmpdir(), "subagents-"));
    mkdirSync(join(dir, "subagents"));
    const sub = join(dir, "subagents");
    writeFileSync(
      join(sub, "agent-aaa.jsonl"),
      [assistant([{ type: "text", text: "done!" }], "end_turn"), hook("SubagentStop")].join("\n"),
    );
    writeFileSync(
      join(sub, "agent-aaa.meta.json"),
      '{"agentType":"repo-researcher","description":"調査"}',
    );
    writeFileSync(
      join(sub, "agent-bbb.jsonl"),
      assistant([{ type: "tool_use", id: "t", name: "Bash", input: {} }], "tool_use"),
    );
    // meta 無し + 古い更新時刻 → stale、種類は既定値
    const old = new Date(Date.now() - STALE_AFTER_MS * 2);
    utimesSync(join(sub, "agent-bbb.jsonl"), old, old);
    writeFileSync(join(sub, "ignored.txt"), "x");

    const list = await readSubagentsDir(sub);
    expect(list.map((s) => [s.agentId, s.status, s.agentType, s.description])).toEqual([
      ["aaa", "done", "repo-researcher", "調査"],
      ["bbb", "stale", "agent", null],
    ]);
    expect(list[0].lastMessage).toBe("done!");
  });
});
