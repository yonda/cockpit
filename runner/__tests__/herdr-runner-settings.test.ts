import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// runner/herdr-runner-settings.json は無人 HerdrExecutor に渡す権限設定。
// JSON なので実行はできないが、権限4層モデル (docs/permission-philosophy.md) の
// 不変条件をここで固定し、allow が過剰に広がる/deny が抜ける回帰を防ぐ。
// Issue #81: layer-2「submit＝自由」を allow に配線した際のガード。

const settings = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "herdr-runner-settings.json"),
    "utf8",
  ),
) as {
  permissions: { defaultMode: string; allow: string[]; deny: string[] };
};

describe("herdr-runner-settings permissions", () => {
  const { allow, deny } = settings.permissions;

  it("layer-2 (submit): エージェントが実際に叩く提出・読み取りコマンドを allow する", () => {
    // buildPrompt / buildReviewReplyPrompt (runner/workflow.ts) が指示する操作に対応:
    expect(allow).toContain("Bash(git push:*)"); // 実装後の push (force は deny 側で除外)
    expect(allow).toContain("Bash(gh pr create:*)"); // draft PR 作成
    expect(allow).toContain("Bash(gh pr view:*)"); // review-reply の reviewThreads 確認 / 自己確認
    expect(allow).toContain("Bash(gh issue view:*)"); // read-only の issue 参照
    expect(allow).toContain("Bash(gh issue comment:*)"); // no-changes 完了時のエビデンス投稿 (buildPrompt)
  });

  it("layer-2 の allow を書き込み可能な広いコマンドへ広げない", () => {
    // gh api は任意エンドポイントへの書き込みが可能なため無条件 allow しない (要件 #4)。
    // merge/ready や force push を allow 側に混ぜない (deny が本丸だが二重の歯止め)。
    const forbidden = [
      "Bash(gh api:*)",
      "Bash(gh pr merge:*)",
      "Bash(gh pr ready:*)",
      "Bash(git push --force:*)",
      "Bash(rm:*)",
    ];
    for (const f of forbidden) expect(allow).not.toContain(f);
    // 素の gh / git を丸ごと通す形 (実質何でも) になっていないこと
    expect(allow).not.toContain("Bash(gh:*)");
    expect(allow).not.toContain("Bash(git:*)");
  });

  it("layer-3 (integrate): merge/ready/force/rm/Skill は deny のまま維持する", () => {
    expect(deny).toContain("Bash(gh pr merge:*)");
    expect(deny).toContain("Bash(gh pr ready:*)");
    expect(deny).toContain("Bash(git push --force:*)");
    expect(deny).toContain("Bash(git push --force-with-lease:*)");
    expect(deny).toContain("Bash(rm:*)");
    expect(deny).toContain("Skill");
  });

  it("deny と allow が衝突する危険操作は deny 側にのみ存在する (deny > allow 前提)", () => {
    // Claude Code は deny を allow より優先評価する。force push は allow の
    // `git push:*` に prefix 一致するが、deny の `git push --force*` が勝つ。
    // その前提が崩れないよう、force を allow に直接入れていないことを担保する。
    for (const d of deny) expect(allow).not.toContain(d);
  });
});
