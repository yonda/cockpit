# セクションエラーの表示改善と自動リカバリ

2026-07-09

## 背景

PC スリープ復帰などでネットワークが一時的に落ちると、Server Component 内の
GitHub API への fetch が `ENOTFOUND` / `ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT`
で失敗し、セクションが「fault · load failed」+ 本番でマスクされた digest
メッセージになる。さらに `SectionBoundary`（クラスコンポーネントの error
boundary）は一度エラーを捕捉すると `state.error` がリセットされないため、
15 秒ポーリング（`RefreshButton` の `router.refresh()`）でネットワークが
復活してもフルリロードまで表示が固まったままになる。

## 方針

**fetch 起因のエラーは throw させず、サーバー側で catch してエラー UI を
レンダリングする。**

- エラー UI が「通常のレンダリング結果」になるため、本番でもメッセージが
  マスクされない（digest 化されるのは throw されたエラーだけ）
- 15 秒ポーリングの `router.refresh()` が成功した時点で、バウンダリの
  state を経由せずに自動復帰する

## 構成

### 1. エラー分類（`app/_components/ErrorState.tsx` 内の classifier）

cause チェーンを辿って分類する純関数:

- **offline**: `TypeError: fetch failed`、または cause チェーンに
  `ENOTFOUND` / `ETIMEDOUT` / `ECONNREFUSED` / `ECONNRESET` / `EAI_AGAIN` /
  `UND_ERR_CONNECT_TIMEOUT` / `UND_ERR_HEADERS_TIMEOUT` 等のコードを含む
  → ネットワーク断。一時的なものとして扱う
- **api**: `GitHubApiError`（HTTP エラー・GraphQL エラー・スコープ不足等）
  → GitHub には届いたが失敗。メッセージをそのまま表示する
- **unknown**: それ以外

### 2. ErrorState の variant

- **offline**: 警告トーン（`--signal-warn`）+ WifiOff アイコン。
  「offline · can't reach github」+「auto-reconnects every 15s」。
  スリープ復帰のたびに赤い故障表示を出さない
- **fault**（api / unknown）: 現状に近い alert トーン + 実際のエラーメッセージ

`SectionErrorState({ error })` が分類 → variant へのマッピングを担う。

### 3. サーバー側 catch への切り替え

fetch している各 Server Component で try/catch し、失敗時は
`<SectionErrorState error={err} />` を返す:

- `PullRequestsTierCell` / `PullRequestsBoard`（`fetchBuckets`）
- `ActivityBoard`（`fetchViewer` + `fetchActivityEvents`）
- `TodaySchedule`（既存の try/catch を SectionErrorState に統一）

`layout.tsx` の `fetchViewerStatus` は既に `.catch(() => null)` 済みで対象外。

### 4. SectionBoundary は最後の砦として残す

fetch 起因のエラーはもう到達しないが、想定外のレンダリングバグ用に残す。
実装は Next 16.2 の `unstable_catchError`（`next/error`）に置き換え、
fallback に `unstable_retry()`（再フェッチ付きリトライ）ボタンを付ける。
クライアントナビゲーションでエラー状態が自動クリアされる等、手書きの
クラスバウンダリより framework-aware。

### 5. エンドポイントの env 上書き

`GITHUB_GRAPHQL_URL` 環境変数でエンドポイントを上書き可能にする
（デフォルト `https://api.github.com/graphql`）。offline 表示の検証
（到達不能ホストに向ける）に使う。

## 検証

- `tsc --noEmit` / `eslint` / `next build`
- `GITHUB_GRAPHQL_URL=https://api.github.invalid PORT=3001 pnpm start` で
  offline variant の表示を確認（本物の `ENOTFOUND` を再現）
- 通常の :3000 で正常表示を確認（自動復帰はエラー UI が通常レンダリング
  結果になったことで構造的に保証される）
