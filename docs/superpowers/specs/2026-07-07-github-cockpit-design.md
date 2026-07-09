# github-cockpit 設計書

- 作成日: 2026-07-07
- 対象: 自分専用のローカル GitHub PR ダッシュボード（MVP）

## 1. 目的とスコープ

### 解決したい痛み

1. レビュー待ちPR（自分がレビュアー指名されている）を見落とす
2. 自分が作ったPRの進捗が Slack / GitHub 通知 / メール に散らばって把握しづらい

### MVP スコープ

| 項目          | 内容                                                            |
|---------------|-----------------------------------------------------------------|
| 対象          | 対象 Org の open な Pull Request のみ                          |
| セクション    | 「Review 待ち」「自分のPR」「メンション」の3セクション（役割軸）|
| アクション    | 閲覧 + GitHub へのリンクのみ（ミューテーションなし）             |
| Issue         | MVP では扱わない（拡張余地は残す）                              |
| 通知          | MVP では実装しない                                              |
| ユーザー数    | 1名（本人）・ローカル起動のみ                                   |

### 明示的に MVP に含めないもの

- 複数 Org 対応
- タグ / メモ / 優先度など GitHub 外のメタデータ
- Approve / Comment / Merge などのミューテーション
- Slack / macOS 通知
- クローズ済みPR、Issue、Discussion
- ダッシュボードの共有機能・マルチテナント
- CI（1人ローカルのため）

## 2. 全体アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  Browser (localhost:3000)                   │
│  - / (Dashboard: 3セクション表示)            │
│  - "更新" ボタン → router.refresh()          │
└──────────────┬──────────────────────────────┘
               │ RSC render request
               ▼
┌─────────────────────────────────────────────┐
│  Next.js App Router (server)                │
│  - app/page.tsx (RSC)                        │
│  - app/_components/sections/*Section.tsx     │
│      ↓ 各 section が並列に fetch             │
│  - lib/github/queries.ts                     │
│      ├─ reviewRequestedForMe()               │
│      ├─ myOpenPullRequests()                 │
│      └─ mentioningMe()                       │
│  - lib/github/client.ts                      │
│      └─ graphql() … fetch to api.github.com  │
│           + { next: { revalidate: 60,        │
│               tags: ["prs"] } }              │
└──────────────┬──────────────────────────────┘
               │ GraphQL (Bearer <gh token>)
               ▼
          GitHub GraphQL API
```

### 主要な設計判断

- **単一プロセス**: `next dev` だけで完結。cron や別デーモンなし。
- **キャッシュ**: Next.js の Data Cache に `revalidate: 60`。手動更新は `router.refresh()` で RSC の再描画をトリガー。
- **認証**: 起動スクリプト（`bin/dev`）で `GITHUB_TOKEN=$(gh auth token)` をセットして `next dev` を exec する。OAuth App の登録は行わない。
- **セクションごとに独立したクエリ**: 1つのセクションが失敗しても他は表示継続。1リクエストにまとめる最適化より、独立エラーハンドリング優先。

## 3. データモデルと GraphQL クエリ

### PullRequestCard 型

```ts
type PullRequestCard = {
  id: string;                    // GraphQL node ID
  number: number;
  title: string;
  url: string;                   // https://github.com/...
  repository: {
    nameWithOwner: string;       // "my-org/xxx"
  };
  author: {
    login: string;
    avatarUrl: string;
  };
  isDraft: boolean;
  createdAt: string;             // ISO
  updatedAt: string;             // ISO
  additions: number;
  deletions: number;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  statusCheckRollup: "SUCCESS" | "PENDING" | "FAILURE" | "ERROR" | null;
  comments: { totalCount: number };
  reviewThreads: { totalCount: number };
};
```

### 3セクションの検索クエリ

`org:<GITHUB_ORG>` を注入する。`archived:false` でアーカイブ済みリポジトリを除外する。

- **Review 待ち**: `search(query: "is:open is:pr review-requested:@me archived:false org:<ORG>", type: ISSUE)`
- **自分のPR**: `search(query: "is:open is:pr author:@me archived:false org:<ORG>", type: ISSUE)`
- **メンション**: `search(query: "is:open is:pr mentions:@me archived:false org:<ORG>", type: ISSUE)`

各セクションを別々の GraphQL リクエストとして発行し、Server Component 側で並列 fetch する。

### ヘッダ表示用のクエリ

ヘッダの「Signed in as @xxx」を表示するため、`layout.tsx` から `viewer { login }` を取得する軽量クエリを1回だけ発行する（`revalidate: 3600`）。

### GraphQL クエリのフラグメント

3セクションは同じ `PullRequestCard` フィールドを返すため、共通の named fragment を定義して再利用する:

```graphql
fragment PullRequestCardFields on PullRequest {
  id
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  additions
  deletions
  reviewDecision
  mergeable
  repository { nameWithOwner }
  author { login avatarUrl }
  comments { totalCount }
  reviewThreads { totalCount }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup { state }
      }
    }
  }
}
```

`statusCheckRollup.state` は変換層（`toCard.ts`）で `PullRequestCard.statusCheckRollup` にマップする。

## 4. UI 構造

### ルート

MVP は `/` のみの1ページ構成。

### レイアウト概念図

```
┌──────────────────────────────────────────────────┐
│  🚀 github-cockpit                     [🔄 更新] │
│  Signed in as @you · Org: my-org · 12:34 更新   │
├──────────────────────────────────────────────────┤
│  ▼ Review 待ち (5)                                │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐              │
│  │Card│ │Card│ │Card│ │Card│ │Card│  … grid       │
│  └────┘ └────┘ └────┘ └────┘ └────┘              │
├──────────────────────────────────────────────────┤
│  ▼ 自分のPR (3)                                   │
│  ┌────┐ ┌────┐ ┌────┐                            │
│  │Card│ │Card│ │Card│                            │
│  └────┘ └────┘ └────┘                            │
├──────────────────────────────────────────────────┤
│  ▼ メンション (2)                                 │
│  ┌────┐ ┌────┐                                   │
│  │Card│ │Card│                                   │
│  └────┘ └────┘                                   │
└──────────────────────────────────────────────────┘
```

### PR カードの中身

- ヘッダ: `my-org/xxx #1234`（repo + PR番号）
- タイトル: 1〜2行で折り返し
- メタ: `@author · 2h ago · +142 −38`
- バッジ群: 下記ルール参照

### バッジ表示ルール

| バッジ         | 表示条件                                          |
|----------------|---------------------------------------------------|
| `Draft`        | `isDraft === true`                                |
| `✅ CI`        | `statusCheckRollup === "SUCCESS"`                 |
| `❌ CI`        | `statusCheckRollup === "FAILURE" \|\| "ERROR"`    |
| `⏳ CI`        | `statusCheckRollup === "PENDING"`                 |
| `👍 Approved`  | `reviewDecision === "APPROVED"`                   |
| `✋ 変更要求`   | `reviewDecision === "CHANGES_REQUESTED"`          |
| `⚠️ Conflict`  | `mergeable === "CONFLICTING"`                     |

### インタラクション

- カード全体を `<a href={pr.url} target="_blank" rel="noopener noreferrer">` で包む
- 右上「🔄 更新」ボタンは Client Component で `router.refresh()` を呼ぶ
- セクションヘッダのクリックで折りたたみ（`useState` の local state）

### 使用ライブラリ

- **UI**: Tailwind CSS v4 + shadcn/ui（Card, Badge）
- **アイコン**: `lucide-react`
- **時刻表示**: `date-fns/formatDistanceToNow`（ja locale, "2時間前"）

## 5. エラー処理と起動時の前提

### 起動スクリプト `bin/dev`

```bash
#!/usr/bin/env bash
set -euo pipefail

command -v gh >/dev/null || { echo "gh CLI が必要です: brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh auth login を先に実行してください"; exit 1; }
[[ -f .env.local ]] || { echo ".env.local が無いです。GITHUB_ORG=... を書いてください"; exit 1; }

export GITHUB_TOKEN="$(gh auth token)"
exec pnpm next dev
```

### ランタイムのエラー処理方針

| 発生源                        | 挙動                                                             |
|-------------------------------|------------------------------------------------------------------|
| GitHub API 401/403           | `app/error.tsx` で「トークンの再発行が必要」と表示 + 再起動を促す |
| GitHub API 5xx / タイムアウト | セクションごとに `<ErrorState />` を表示（他セクションは表示継続）|
| Rate limit                    | ヘッダから残量を読み、残 < 100 でヘッダに黄色バナーを出す         |
| ネットワーク断                | セクションごとに「再取得」ボタン付きのエラーカード                |
| 該当PR 0件                    | セクションは表示するが「該当なし」の空状態カード                  |

### セクション独立のエラーバウンダリ

```tsx
<section>
  <h2>Review 待ち</h2>
  <Suspense fallback={<Skeleton />}>
    <ErrorBoundary fallback={<ErrorState />}>
      <ReviewRequestedSection />
    </ErrorBoundary>
  </Suspense>
</section>
```

### `.env.local` テンプレート

`.env.local.example` を含める:

```
GITHUB_ORG=my-org
```

## 6. テスト方針

### テストする対象

| 対象                                           | やり方                          | 理由                                       |
|------------------------------------------------|---------------------------------|--------------------------------------------|
| GraphQL レスポンス → PullRequestCard 変換ロジック | Vitest（fixture JSON を用意）    | 一番間違えやすく回帰しやすい部分            |
| バッジ表示ルール                                | Vitest                          | if/else が増える。表で言えるロジック        |
| 時刻フォーマット / 相対時刻                     | Vitest                          | `formatDistanceToNow` のラッパー           |
| PR カードコンポーネント                         | Vitest + React Testing Library   | Server Component も同期関数として扱える     |

### テストしない対象

- `lib/github/client.ts`（fetch そのもの）
- Suspense / ErrorBoundary の境界挙動（Next.js の責務）
- 認証スクリプト（bash なので手動確認）
- E2E テスト（1人ローカルツールのため）

### fixture の集め方

- `pnpm dev` で1回実行して GraphQL レスポンスを `test/fixtures/*.json` に保存する
- 秘匿情報（org 名、レポ名、ユーザー名）は sed で置換する

### CI

MVP では CI を組まない。`pnpm typecheck && pnpm test` を pre-commit hook で回せる余地だけ残す。

## 7. プロジェクト構造

```
github-cockpit/
├── .env.local.example        # GITHUB_ORG=...
├── .gitignore
├── README.md                 # セットアップ手順
├── bin/
│   └── dev                   # gh auth token を注入して next dev
├── package.json              # pnpm, scripts: dev/build/test/typecheck
├── tsconfig.json
├── next.config.ts
├── postcss.config.mjs        # Tailwind v4
├── app/
│   ├── layout.tsx            # <html>, Tailwind global
│   ├── page.tsx              # RSC: 3セクションを縦に並べる
│   ├── error.tsx             # 401/認証エラー用
│   ├── globals.css
│   └── _components/
│       ├── RefreshButton.tsx           # "use client" + router.refresh()
│       ├── SectionHeader.tsx           # 折りたたみUI
│       ├── PullRequestCard.tsx         # カード本体
│       ├── PullRequestGrid.tsx         # カードのグリッド配置
│       ├── EmptyState.tsx
│       ├── ErrorState.tsx
│       └── sections/
│           ├── ReviewRequestedSection.tsx  # 各 async server component
│           ├── MyPullRequestsSection.tsx
│           └── MentionsSection.tsx
├── lib/
│   ├── env.ts                # GITHUB_ORG / GITHUB_TOKEN の検証
│   ├── github/
│   │   ├── client.ts         # graphql() fetch wrapper
│   │   ├── queries.ts        # 3つのGraphQLクエリ文字列
│   │   ├── types.ts          # PullRequestCard 等
│   │   └── toCard.ts         # GraphQL レスポンス → PullRequestCard 変換
│   └── format/
│       └── relativeTime.ts   # date-fns の薄いラッパー
├── test/
│   ├── fixtures/
│   │   ├── reviewRequested.json
│   │   ├── myPullRequests.json
│   │   └── mentions.json
│   ├── toCard.test.ts
│   ├── relativeTime.test.ts
│   └── PullRequestCard.test.tsx
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-07-07-github-cockpit-design.md
└── vitest.config.ts
```

### 依存関係

- **ランタイム**: `next`, `react`, `react-dom`, `date-fns`
- **UI**: `tailwindcss@4`, `class-variance-authority`, `lucide-react`, `@radix-ui/*`（shadcn/ui 経由）
- **開発**: `typescript`, `vitest`, `@testing-library/react`, `jsdom`, `@types/*`
- **パッケージマネージャ**: `pnpm`（`package.json` の `packageManager` に固定）

### 起動フロー（README に書く手順）

```bash
git clone <url> && cd github-cockpit
pnpm install
cp .env.local.example .env.local  # GITHUB_ORG を書く
./bin/dev                          # → http://localhost:3000
```

## 8. 将来の拡張余地（MVP には含めない）

- Issue セクション追加（PullRequestCard と同じ変換パターンで拡張可能）
- 複数 Org 対応（`.env.local` に `GITHUB_ORGS=A,B` を書けるようにする）
- Slack / macOS 通知（cron ベースの独立プロセスで JSON を書き出し、diff を通知）
- 「今日やる」タグなどローカルメタデータ（SQLite の導入）
- Approve / Comment / Merge のミューテーション
- Vercel などへのデプロイ時に OAuth Web Flow（Auth.js）へ切り替え
