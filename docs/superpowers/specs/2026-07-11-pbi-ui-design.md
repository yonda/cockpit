# PBI UI（/pbi ページ）設計

- 日付: 2026-07-11
- ステータス: 設計承認済み・実装前
- 前提: PBI オーケストレーション・コア（`specs/2026-07-10-pbi-orchestration-design.md`、runner 側は main 実装済み）の上に載る最初の UI サブプロジェクト

## 目的とスコープ

PBI フローを **1 枚の `/pbi` ページで end-to-end に回せる**ようにする。発射 → 分解承認 → sub-task 実行監視・許可応答 → PR レビュー → 完了、までを 1 画面で完結させ、実機 dogfood を可能にする。

design spec が将来像として描いた「受信箱(Inbox) を玄関に」「PBI ボードと発射台を分離」という情報設計は、本 v1 では**あえて単一ページに集約**する。横断集約の受信箱・独立ボードへの分割は、この v1 を回して体感してから別サブプロジェクトで切り出す。

## 決定事項（ブレインストーミングでの合意）

| 論点 | 決定 |
|---|---|
| ナビ配置 | 独立した `/pbi` タブを新設。既存 `/launch`・PR/WIP ボード群は不変 |
| ページ全体レイアウト | 縦フィード（PBI カードを積む）。少数同時進行・「上から片付ける」運用に合わせる |
| 許可/質問の応答 | 該当 sub-task カードに**インライン応答**（`/launch` に飛ばさない） |
| PR レビュー | カードは GitHub PR へのリンクのみ。レビュー・マージは GitHub 上、マージ検知は runner が自動 |
| レビューコメント対応 | **「対応を発射」をワンタップで**（v1 に含める）。runner 側に返信ジョブ発射メソッドを新設する |
| 発射 | `pbi` ラベルの open Issue 一覧モーダルから選択して発射。Definition of Ready 未充足はワーニング表示（発射は可能） |

## アーキテクチャ

既存 Launch Pad UI（`app/launch/page.tsx` + `app/_components/{LaunchBoard,JobCard,useJobsState,JobNotifyWatcher}.tsx` + `app/api/jobs/*`）のパターンを踏襲する。

```
┌─ /pbi ページ ───────────────────────────────┐
│  PbiBoard: 縦フィード + ⚡発射モーダル          │
│  PbiCard: 状態別（分解中/承認待ち/実行中/端）    │
│   └ SubTaskRow: 状態バッジ + 文脈アクション      │
│      └ 許可/質問インライン応答（job.respond）    │
└──────────┬──────────────────────────────────┘
           │ usePbiState フック
┌─ Next.js (com.cockpit.app) ─────────────────┐
│  app/api/pbi/*  … runner pbi.* への薄いプロキシ │
│  app/api/pbi/events … SSE (pbi.updated)       │
│  既存 lib/runner/client.ts を流用              │
└──────────┬──────────────────────────────────┘
           │ unix socket
┌─ runner デーモン ───────────────────────────┐
│  既存 pbi.* メソッド + 新設 pbi.fireReviewReply │
└──────────────────────────────────────────────┘
```

### データ層: `usePbiState` フック

`useJobsState` と同流儀。`app/api/pbi/events`（SSE）が runner の `pbi.updated` を中継。**加えて既存 `job.updated` も購読**し、各 PBI の sub-task の `jobId` で Launch Pad ジョブ状態を突き合わせる。これにより:

- 実行中 sub-task の 1 行アクティビティ（`Job.lastActivity`）
- 実行中 sub-task の許可/質問（`Job.pendingInput`）をカードにインライン表示

を得る。フックは `{ pbis: PbiJob[], jobsById: Map<jobId, Job> }` を返し、カードは `subTask.jobId` で join する。

### API プロキシ（`app/api/pbi/*` → runner socket）

`lib/runner/client.ts` の `callRunner` / `openRunnerEventStream` を流用:

- `GET /api/pbi` → `pbi.list`
- `GET /api/pbi/events` → SSE（`pbi.updated` + 既存 `job.updated`）
- `POST /api/pbi/fire` → `pbi.fire`（`{repo, issueNumber, title}`）
- `POST /api/pbi/[id]/approve` `/revise` `/reject` `/pause` `/resume` `/cancel`
- `POST /api/pbi/[id]/task/[key]/retry` `/skip`
- `POST /api/pbi/[id]/task/[key]/review-reply` → 新設 `pbi.fireReviewReply`
- sub-task の許可/質問応答は既存 `POST /api/jobs/[id]/respond`（`job.respond`）を再利用

## PBI カード（ライフサイクル状態別）

縦フィードに `createdAt` 降順で並べる。端状態（completed/cancelled）は薄表示で下部。

- **decomposing**: スピナー「分解中…」＋ Issue タイトル
- **awaiting_approval（分解ゲート）**: proposed sub-task 一覧（key / タイトル / 成果物 / 依存）＋ 分解の根拠・リスク。アクション: **承認して実行** / **修正指示…**（テキスト入力 → `pbi.revise`）/ **却下**
- **executing**: sub-task ごとに 1 行 = 状態バッジ + 文脈アクション:
  - `merged` ✓（薄表示）
  - `in_review`: 「PR #NN レビュー待ち」＋ GitHub リンク。`review_comments` エスカレーションがあれば「💬 N 件 → 対応を発射」
  - `running`: 1 行アクティビティ表示。`pendingInput` があれば許可(許可/拒否)・質問(選択肢)を**インライン応答**
  - `failed`: `task_failed` エスカレーション → **リトライ** / **スキップ**
  - `pending`: 「待機（依存 tX）」
  - PBI 単位: **一時停止 / 再開**、**中止**
- **completed / failed / cancelled**: 端状態サマリ（完了数・最終 PR 等）

## 発射フロー

「⚡ PBI を発射」→ `pbi` ラベルの open Issue 一覧モーダル。Issue フェッチは `/launch` の Issue フェッチャ実装を流用（`gh issue list --label pbi --json`）。選択で `pbi.fire`。Definition of Ready（ストーリー/受け入れ基準/非スコープ）を満たさない Issue には warning バッジ（発射は可能 — ガードレールであって手錠にしない）。

## レビューコメント対応（runner 新設ぶん）

design spec の後続扱いだったワンタップ発射を v1 に含める。

**新設 socket メソッド `pbi.fireReviewReply({ pbiId, key })`**:
1. その sub-task の `review_comments` エスカレーションをクリア
2. sub-task の既存 worktree / ブランチで「レビュー返信ジョブ」を発射 — PR の未解決レビュースレッドを `gh` で取得し、エージェントが対応（修正 → push → スレッド返信）。既存の `reply-review-comments` の流儀に沿う
3. sub-task の状態は `in_review` のまま（PR は開いたまま更新される）。ポーラーが引き続き監視し、新たなコメントが付けば再度 `review_comments` エスカレーションを立てる

実装は既存 Launch Pad ジョブ基盤の再利用を基本とする（sub-task の worktree・ブランチを使い、返信用プロンプトでエージェントを走らせる）。詳細な実装方式（Job への種別追加か別ワークフローか、セッション resume の可否）は実装計画で決める。closing keyword ハザード（Launch Pad の dogfood で判明した「closes #n で Issue 早期クローズ→マージ検知が壊れる」問題）と同じく、返信ジョブのプロンプトでも closing keyword を書かせない。

## 通知

既存 `JobNotifyWatcher` / PWA 通知機構を踏襲。`awaiting_approval` への遷移・sub-task の `pendingInput` 発生・`failed` / `pr_closed_unmerged` エスカレーションで通知（音・PWA）。iPhone からの承認・許可応答も既存の通知基盤に乗る。細かな出し分けは実装時に調整。

## テスト戦略

- **API プロキシ**: 既存 `app/api/jobs/*` テストの流儀（runner client をモックし、正しい pbi.* メソッド・パラメータで呼ぶことを検証）。
- **`usePbiState` フック**: SSE の `pbi.updated` + `job.updated` を注入し、pbis と jobsById の join・状態遷移を検証。
- **カード**: 各ライフサイクル状態のレンダリングと、状態別アクションの表示（承認/リトライ/許可応答/レビュー対応）を検証。
- **`pbi.fireReviewReply`**（runner 側）: 既存 runner テスト流儀（injectable deps・フェイク）でエスカレーションクリア + ジョブ発射を検証。
- 結合は dogfood（実 PBI を 1 本、発射→承認→実行→PR→マージ→完了）で確認。

## スコープ外（後続サブプロジェクト）

- 受信箱(Inbox) の横断集約（全 PBI + 全 job の「要対応」一列）と、それを玄関に据える情報設計の再編
- 独立した PBI ボード（依存グラフのビジュアル表示、ライブログの専用ビュー）
- リポジトリ別設定 UI・ガードレール整備・Findy 展開
- PBI Issue テンプレート（`.github/ISSUE_TEMPLATE/pbi.md`）の整備そのもの（本 UI は既存 `pbi` ラベル運用を前提）
- フォロータスク追加 UI（PBI 完了後の受け入れで見つかった不備の追加）
