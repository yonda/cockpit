import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trustWorktree } from "../herdr-boot";

describe("trustWorktree", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
    file = path.join(dir, ".claude.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ファイルが無くても projects[cwd].hasTrustDialogAccepted を書く", async () => {
    await trustWorktree("/wt/job", file);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(json.projects["/wt/job"].hasTrustDialogAccepted).toBe(true);
  });

  it("パース不能 (破損/書き込み途中) なら throw して全書き換えしない", async () => {
    fs.writeFileSync(file, '{"projects": {"/keep": {"hasT'); // 破損
    await expect(trustWorktree("/wt/job", file)).rejects.toThrow();
    // 元ファイルは壊さない (データ損失を避ける)
    expect(fs.readFileSync(file, "utf8")).toBe('{"projects": {"/keep": {"hasT');
  });

  it("既存の他プロジェクト設定を壊さない", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        projects: { "/other": { hasTrustDialogAccepted: true, foo: 1 } },
        topLevel: "keep",
      }),
    );
    await trustWorktree("/wt/job", file);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(json.topLevel).toBe("keep");
    expect(json.projects["/other"]).toEqual({
      hasTrustDialogAccepted: true,
      foo: 1,
    });
    expect(json.projects["/wt/job"].hasTrustDialogAccepted).toBe(true);
  });
});
