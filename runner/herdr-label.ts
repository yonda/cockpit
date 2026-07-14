// fire したジョブ (issue) を herdr のサイドバー上で一目で識別できる workspace label を
// 組み立てる純関数。副作用なし・herdr へのアクセスなしで、truncate と日本語 (全角) の
// 表示崩れを単体で検証できるようにこのファイルへ切り出している (Issue #123)。
//
// 命名規則: '<repo短名>#<issueNumber> <タイトル…>'  (例: 'cockpit#123 検索が…')
//   - repo は 'owner/name' から name のみ抽出する
//   - タイトルはサイドバー幅を考慮した最大表示幅で truncate し、超過時のみ省略記号を付ける
//   - 全角文字は表示上 2 カラムを占める前提で幅計算する (幅で切るので文字境界で壊れない)

/** 省略記号 (U+2026 HORIZONTAL ELLIPSIS)。表示幅は 1 カラムとして扱う。 */
const ELLIPSIS = "…";

/**
 * label 全体の最大表示幅 (カラム数)。herdr サイドバーのタブ幅を考慮した値。
 * head ('<repo短名>#<issueNumber> ') とタイトルの合計がこの幅に収まるよう truncate する。
 */
export const WORKSPACE_LABEL_MAX_WIDTH = 32;

/**
 * 1 コードポイントの表示幅 (East Asian Width の簡易判定)。
 * CJK・かな・全角記号・ハングル・絵文字などは 2 カラム、それ以外は 1 カラム。
 * 網羅的な Unicode テーブルではなく、タイトル表示に現れる主要な全角レンジのみを対象にする。
 */
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首補助・康熙部首・CJK 記号
    (cp >= 0x3041 && cp <= 0x33ff) || // ひらがな・カタカナ・CJK 記号と約物・全角囲み
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 統合漢字拡張 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 統合漢字
    (cp >= 0xa000 && cp <= 0xa4cf) || // イ文字
    (cp >= 0xac00 && cp <= 0xd7a3) || // ハングル音節
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 互換漢字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 互換形
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII・全角記号
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角通貨記号など
    (cp >= 0x1f300 && cp <= 0x1faff) || // 絵文字
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 統合漢字拡張 B 以降
  ) {
    return 2;
  }
  return 1;
}

/** 文字列全体の表示幅 (カラム数)。コードポイント単位で合算する。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0)!);
  return width;
}

/**
 * text を最大 maxWidth カラムに収まるよう truncate する。超過する場合のみ末尾に省略記号を付け、
 * 省略記号自身の幅も maxWidth に含めて収める。コードポイント単位で処理するため、
 * サロゲートペアや全角文字を途中で分割して壊すことはない。
 */
function truncateByWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;

  const budget = maxWidth - charWidth(ELLIPSIS.codePointAt(0)!);
  let result = "";
  let width = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (width + cw > budget) break;
    result += ch;
    width += cw;
  }
  return result + ELLIPSIS;
}

/** 'owner/name' から repo 短名 (name) を取り出す。スラッシュが無ければそのまま返す。 */
function shortRepoName(repo: string): string {
  const segments = repo.split("/").filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : repo;
}

export type BuildWorkspaceLabelInput = {
  /** 'owner/name' 形式のリポジトリ名 (name のみ抽出して使う)。 */
  repo: string;
  /** issue 番号。 */
  issueNumber: number;
  /** issue タイトル。空・短い場合は省略記号を付けずそのまま出す。 */
  issueTitle: string;
};

/**
 * herdr ワークスペースの label を組み立てる純関数。
 * '<repo短名>#<issueNumber> <タイトル…>' を返し、タイトルは全体が
 * WORKSPACE_LABEL_MAX_WIDTH カラムに収まるよう truncate する。
 * タイトルが空のときは末尾の区切り空白も付けない。
 */
export function buildWorkspaceLabel({
  repo,
  issueNumber,
  issueTitle,
}: BuildWorkspaceLabelInput): string {
  const head = `${shortRepoName(repo)}#${issueNumber}`;
  const title = issueTitle.trim();
  if (title.length === 0) return head;

  // head と区切り空白 (1 カラム) を差し引いた残りをタイトルの表示幅予算にする。
  const titleBudget = WORKSPACE_LABEL_MAX_WIDTH - displayWidth(head) - 1;
  // head だけで予算を使い切っている場合はタイトルを付けない (head を優先)。
  if (titleBudget <= 0) return head;

  return `${head} ${truncateByWidth(title, titleBudget)}`;
}
