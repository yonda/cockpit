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
