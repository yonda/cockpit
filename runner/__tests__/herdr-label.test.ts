import { describe, expect, it } from "vitest";
import {
  buildWorkspaceLabel,
  WORKSPACE_LABEL_MAX_WIDTH,
} from "../herdr-label";

// 表示幅 (全角=2, それ以外=1) をテスト側でも独立に数える簡易実装。
// 実装の内部関数に依存せず「label の表示幅が上限を超えない」ことを検証するために使う。
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

// 壊れた文字 (対になっていないサロゲート) が含まれていないか。
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // high surrogate: 直後に low surrogate が続かなければ壊れている
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // 対を消費
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // 先行 high 無しの low surrogate
      return true;
    }
  }
  return false;
}

describe("buildWorkspaceLabel", () => {
  it("'owner/name' から repo 短名を抽出する", () => {
    expect(
      buildWorkspaceLabel({
        repo: "yonda/cockpit",
        issueNumber: 123,
        issueTitle: "",
      }),
    ).toBe("cockpit#123");
  });

  it("スラッシュが無い repo はそのまま短名として使う", () => {
    expect(
      buildWorkspaceLabel({ repo: "cockpit", issueNumber: 1, issueTitle: "" }),
    ).toBe("cockpit#1");
  });

  it("末尾スラッシュや入れ子でも最後のセグメントを短名にする", () => {
    expect(
      buildWorkspaceLabel({
        repo: "yonda/cockpit/",
        issueNumber: 1,
        issueTitle: "",
      }),
    ).toBe("cockpit#1");
    expect(
      buildWorkspaceLabel({ repo: "a/b/c", issueNumber: 1, issueTitle: "" }),
    ).toBe("c#1");
  });

  it("長い ASCII タイトルは 'cockpit#123 ' + 先頭N文字 + 省略記号 になる", () => {
    const title = "search is broken and takes forever to return results";
    const label = buildWorkspaceLabel({
      repo: "yonda/cockpit",
      issueNumber: 123,
      issueTitle: title,
    });

    // head='cockpit#123'(11) + 区切り(1) を差し引いた残りがタイトル予算、うち省略記号 1 を除く。
    const head = "cockpit#123";
    const titleBudget = WORKSPACE_LABEL_MAX_WIDTH - head.length - 1;
    const n = titleBudget - 1; // 省略記号 1 カラム分を確保
    expect(label).toBe(`${head} ${title.slice(0, n)}…`);
    // 先頭は固定の 'cockpit#123 ' で始まり、末尾は省略記号。
    expect(label.startsWith("cockpit#123 ")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    // 表示幅は上限を超えない。
    expect(displayWidth(label)).toBeLessThanOrEqual(WORKSPACE_LABEL_MAX_WIDTH);
  });

  it("全角のみの長いタイトルでも truncate 後に文字が壊れない", () => {
    const title = "検索結果が正しく表示されない不具合を至急修正したい";
    const label = buildWorkspaceLabel({
      repo: "yonda/cockpit",
      issueNumber: 123,
      issueTitle: title,
    });

    expect(label.startsWith("cockpit#123 ")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    // 表示幅が上限内。
    expect(displayWidth(label)).toBeLessThanOrEqual(WORKSPACE_LABEL_MAX_WIDTH);
    // 省略部分を除いたタイトルは元タイトルの先頭からの連続 (途中で壊れていない)。
    const truncated = label.slice("cockpit#123 ".length, -1); // 末尾の省略記号を除く
    expect(hasLoneSurrogate(truncated)).toBe(false);
    expect(title.startsWith(truncated)).toBe(true);
  });

  it("全角・ASCII・絵文字 (サロゲートペア) が混在してもサロゲートを分割しない", () => {
    const title = "検索🔍 dashboard の表示が壊れている問題を修正";
    const label = buildWorkspaceLabel({
      repo: "yonda/cockpit",
      issueNumber: 7,
      issueTitle: title,
    });

    expect(hasLoneSurrogate(label)).toBe(false);
    expect(displayWidth(label)).toBeLessThanOrEqual(WORKSPACE_LABEL_MAX_WIDTH);
    const truncated = label.endsWith("…")
      ? label.slice("cockpit#7 ".length, -1)
      : label.slice("cockpit#7 ".length);
    // 途中で分割されていなければ元タイトルの prefix になっている。
    expect(title.startsWith(truncated)).toBe(true);
  });

  it("タイトルが空なら省略記号も末尾の区切り空白も付けない", () => {
    expect(
      buildWorkspaceLabel({
        repo: "yonda/cockpit",
        issueNumber: 42,
        issueTitle: "",
      }),
    ).toBe("cockpit#42");
    // 空白のみも trim して空扱い。
    expect(
      buildWorkspaceLabel({
        repo: "yonda/cockpit",
        issueNumber: 42,
        issueTitle: "   ",
      }),
    ).toBe("cockpit#42");
  });

  it("上限に収まる短いタイトルは省略記号を付けずそのまま出す", () => {
    expect(
      buildWorkspaceLabel({
        repo: "yonda/cockpit",
        issueNumber: 5,
        issueTitle: "fix login",
      }),
    ).toBe("cockpit#5 fix login");
    // 上限内に収まる全角タイトルもそのまま。
    expect(
      buildWorkspaceLabel({
        repo: "yonda/cockpit",
        issueNumber: 5,
        issueTitle: "検索修正",
      }),
    ).toBe("cockpit#5 検索修正");
  });

  it("前後の空白は trim してからタイトルとして使う", () => {
    expect(
      buildWorkspaceLabel({
        repo: "yonda/cockpit",
        issueNumber: 5,
        issueTitle: "  fix login  ",
      }),
    ).toBe("cockpit#5 fix login");
  });

  it("純関数として決定的 (同じ入力なら同じ出力)", () => {
    const input = {
      repo: "yonda/cockpit",
      issueNumber: 123,
      issueTitle: "検索結果が正しく表示されない不具合",
    };
    expect(buildWorkspaceLabel(input)).toBe(buildWorkspaceLabel(input));
    // 入力オブジェクトを破壊しない。
    expect(input.issueTitle).toBe("検索結果が正しく表示されない不具合");
  });
});
