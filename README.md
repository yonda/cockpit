# cockpit

GitHub org の Pull Request・レビュー依頼・自分の WIP を 1 画面に集約する、個人用のコックピット PWA。macOS 上で launchd 常駐の Next.js アプリとして動く。

## 機能

- **PR ボード** — org 内の open PR をレビュー状態で分類して表示
- **WIP ボード** — 自分の作業中 PR・ブランチの状況
- **アクティビティ** — GitHub イベントと Claude Code セッションのタイムライン
- **今日の予定** — icalBuddy 経由でカレンダーを表示（macOS のカレンダー権限のみで動作）
- **エージェント監視** — herdr のペイン状態を表示、通知音つき
- **デスクトップ通知** — レビュー依頼や作業完了を PWA 通知で受け取る

## セットアップ

```bash
pnpm install
cp .env.local.example .env.local   # GITHUB_ORG を自分の org に
# GITHUB_TOKEN は bin/dev / bin/start が gh CLI (gh auth token) から解決する

bin/dev        # 開発サーバー
```

## 常駐させる（launchd）

```bash
pnpm build
bin/service install            # next start を :7878 で常駐
bin/service calendar-install   # カレンダー同期（5 分毎）
bin/service status
```

ビルド更新後の反映は `pnpm build && bin/service restart`。

## ドキュメント

設計メモは `docs/superpowers/specs/` にある。
