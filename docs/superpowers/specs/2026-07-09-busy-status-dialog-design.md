# busy ステータス検知ダイアログ 設計

2026-07-09

## 目的

GitHub のユーザーステータスが busy（`indicatesLimitedAvailability: true`）のまま放置されているのに気づけない問題を解決する。cockpit 利用中は基本 busy で作業しないため、cockpit 上でダイアログを出して気づけるようにし、その場で解除もできるようにする。

## 検知

- `lib/github/queries.ts` に `VIEWER_STATUS_QUERY` を追加（`viewer { status { indicatesLimitedAvailability message expiresAt } }`）
- `lib/github/fetchers.ts` に `fetchViewerStatus()` を追加。**既存 `fetchViewer()`（revalidate 3600）とは別クエリ**にして no-store で毎回取得する
- `app/layout.tsx`（サーバーコンポーネント）で取得し `<BusyStatusDialog status={...} />` に渡す。取得失敗時は `null` 扱いでアプリ全体を巻き込まない
- 更新は既存の `RefreshButton` の 15 秒 `router.refresh()` に相乗り。新規ポーリングループは作らない（GraphQL 3→4 本/15 秒 ≈ 960/h でレート制限に余裕）

## ダイアログ（`app/_components/BusyStatusDialog.tsx`・client）

- busy かつスヌーズ中でないとき、中央モーダルを表示。サウンドなし
- 表示内容: ステータスメッセージ（なければ「busy」）、期限（`expiresAt` があれば HH:mm）
- ボタン:
  - **「busy を解除」**（primary）: `POST /api/github-status/clear` → 成功で `router.refresh()` して閉じる
  - **「あとで（30 分）」**: `localStorage` の `cockpit:busy:snoozeUntil` に期限を保存して閉じる。期限切れ後もまだ busy なら再表示（タイマー + 15 秒ポーリングの両方で拾う）

## 解除 API（`app/api/github-status/clear/route.ts`）

- `changeUserStatus(input: {})` mutation をサーバー側で実行してステータスをクリア
- 失敗時（典型は `user` スコープ不足）は `{ ok: false, error }` を返し、ダイアログ内にエラーと対処（`gh auth refresh -h github.com -s user` → `bin/service restart`）を表示

## 前提（1 回だけ手動）

`changeUserStatus` には `user` スコープが必要。現在の gh トークンには無いため `gh auth refresh -h github.com -s user` を実行し、サービスを再起動する。読み取りは現行スコープで動く。

## テスト

実機確認: `gh api graphql` で busy を立てる → ダイアログ表示 → スヌーズ動作 → 解除ボタンで GitHub 側がクリアされることを確認。
