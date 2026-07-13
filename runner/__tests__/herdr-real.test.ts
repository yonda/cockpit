import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectDir, RealTranscriptReader, redactToken } from "../herdr-real";

describe("encodeProjectDir", () => {
  it("非英数字を - に置換する (/ と . を含む)", () => {
    expect(encodeProjectDir("/Users/alice.b/src/cockpit")).toBe(
      "-Users-alice-b-src-cockpit",
    );
  });
});

describe("redactToken", () => {
  it("token を含むメッセージ中の全出現を *** に置換する", () => {
    const token = "github_pat_secret123";
    const message = `Command failed: herdr pane run p1 "GH_TOKEN=${token} claude" (cmd used ${token})`;
    const redacted = redactToken(message, token);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("***");
    expect(redacted).toBe(
      `Command failed: herdr pane run p1 "GH_TOKEN=*** claude" (cmd used ***)`,
    );
  });

  it("token が null のときはメッセージをそのまま返す", () => {
    const message = "Command failed: herdr pane run p1 (no token)";
    expect(redactToken(message, null)).toBe(message);
  });
});

describe("RealTranscriptReader", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tr-reader-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeTranscript(cwd: string, sessionId: string, body: string) {
    const dir = path.join(root, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(p, body);
    return p;
  }

  it("waitForSession は cwd 配下の最新 jsonl を session_id 付きで返す", async () => {
    const cwd = "/wt/job";
    writeTranscript(cwd, "sess-abc", '{"type":"system"}\n');
    const reader = new RealTranscriptReader(root);
    const found = await reader.waitForSession(cwd, 0, 1000);
    expect(found?.sessionId).toBe("sess-abc");
  });

  it("waitForSession は transcript 未作成なら timeout で null", async () => {
    const reader = new RealTranscriptReader(root);
    const found = await reader.waitForSession("/wt/none", 0, 300);
    expect(found).toBeNull();
  });

  it("readActivitySince は fromOffset 以降の text/tool_use を抽出する", async () => {
    const cwd = "/wt/job";
    const p = writeTranscript(
      cwd,
      "s",
      [
        JSON.stringify({ type: "system" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        }),
        "",
      ].join("\n"),
    );
    const reader = new RealTranscriptReader(root);
    const r = await reader.readActivitySince(p, 0);
    expect(r.activities).toEqual(["tool: Bash", "done"]);
    expect(r.nextOffset).toBe(fs.statSync(p).size); // 全行が確定済み
  });

  it("追記途中の不完全な最終行は nextOffset を進めず次回に持ち越す", async () => {
    const cwd = "/wt/job";
    const complete =
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "a" }] },
      }) + "\n";
    const p = writeTranscript(cwd, "s", complete + '{"type":"assist'); // 途中
    const reader = new RealTranscriptReader(root);
    const r1 = await reader.readActivitySince(p, 0);
    expect(r1.activities).toEqual(["a"]);
    expect(r1.nextOffset).toBe(Buffer.byteLength(complete)); // 完成行の直後まで

    // 最終行が完成したら次回に拾える (増分のみ読む)
    fs.appendFileSync(
      p,
      'ant","message":{"content":[{"type":"tool_use","name":"Edit"}]}}\n',
    );
    const r2 = await reader.readActivitySince(p, r1.nextOffset);
    expect(r2.activities).toEqual(["tool: Edit"]);
  });

  it("追記が無ければ空・オフセット据え置き (増分読み)", async () => {
    const cwd = "/wt/job";
    const p = writeTranscript(
      cwd,
      "s",
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "x" }] },
      }) + "\n",
    );
    const reader = new RealTranscriptReader(root);
    const size = fs.statSync(p).size;
    const r = await reader.readActivitySince(p, size);
    expect(r.activities).toEqual([]);
    expect(r.nextOffset).toBe(size);
  });
});
