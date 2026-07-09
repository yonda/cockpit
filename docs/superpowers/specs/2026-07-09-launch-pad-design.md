# Launch Pad（発射台）設計

- 日付: 2026-07-09
- ステータス: 設計承認済み・実装前

## 背景と目的

cockpit は現在リードオンリーのボード（PR / WIP / Activity / Agents）。長期構想は「CLI で行っている Claude Code 開発プロセスを cockpit に移行する」ことで、そのロードマップは:

1. 観測（herdr ベースの Agents ボード — 実装済み）
2. **発射台（本設計）**: 定型ワークフローをボードのボタンから headless 起動
3. 割り込み対応: 許可プロンプト・質問への回答を cockpit で行う（本設計に同梱）
4. フルセッション: 埋め込みチャット（将来）

本設計のゴール: **Issue をボードから⚡発射すると、worktree 上で headless エージェントが実装して draft PR を作り、途中の許可・質問には cockpit の UI で答えられる。**

## 決定事項（ブレインストーミングでの合意）

| 論点 | 決定 |
|---|---|
| 実行基盤 | 完全 headless（Claude Agent SDK、herdr ペインは使わない） |
| 権限モデル | 許可待ち・質問を cockpit UI に転送（`canUseTool`） |
| 対象スコープ | まず yonda/cockpit 自身で dogfood。他リポジトリへの一般化は後続 |
| 起案 | MVP は既存 open Issue の一覧 + 発射ボタンのみ。起案 UI は作らない |
| 配置 | 同一リポジトリ内・別プロセス（runner デーモン）。別アプリ化はしない |
| UI | 完全に新しい画面（`/launch` タブ）。既存ボードには手を入れない |
| 同時実行数 | 最大 2（キューは無制限、空き次第順次実行） |

## SDK の裏取り結果（設計の前提）

公式ドキュメントで確認済み:

- `canUseTool` はタイムアウトなしで無期限にブロックできる。deny 時は理由がエージェントに渡り、別アプローチを試みる
- `AskUserQuestion` も headless で使え、`canUseTool` で捕捉して回答を返せる。**ただしサブエージェント内からは使えない**（メインループに戻ってから質問される）
- session_id を保存すれば、プロセスが落ちても同一マシンで `resume` 可能
- トランスクリプトは CLI と同じ `~/.claude/projects/<slug>/<sessionId>.jsonl` に書かれる → 既存の `lib/claude/recap.ts` がそのまま使える
- `agents` オプションでサブエージェントが headless でも動く（Team 的並列は 1 セッション内で完結）
- TypeScript SDK は `query()` ごとに CLI を子プロセスとして spawn（起動 ~12 秒）。同時 3〜5 が現実的 → 最大 2 の保守値は妥当
- 許可評価順序: hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool`（allow 済みツールはコールバックをスキップする）

## 全体アーキテクチャ

```
┌─ ブラウザ (PWA) ─────────────────────────────┐
│  /launch: Issue 一覧 + ⚡発射                  │
│  ジョブカード: 状態 / 許可承認 / 質問回答 / PR    │
└──────────┬───────────────────────────────┘
           │ HTTP + SSE
┌─ Next.js (com.cockpit.app) ────────────────┐
│  app/api/jobs/*  … runner への薄いプロキシ     │
│  lib/runner/client.ts … unix ソケットクライアント│
└──────────┬───────────────────────────────┘
           │ unix socket (~/.cache/cockpit/runner.sock)
┌─ runner デーモン (com.cockpit.runner) ───────┐
│  ジョブキュー / 状態を ~/.cache/cockpit/jobs/ に永続化 │
│  ジョブごとに: git wt で worktree 作成          │
│   → Agent SDK query() (canUseTool で許可を保留) │
│   → draft PR 検証 → 通知                      │
└────────────────────────────────────────────┘
```

- **境界ルール**: runner は Next.js のコードを import しない。共有するのは型定義とソケットプロトコルのみ。runner が汎用実行基盤に育ったらリポジトリ分割できる状態を保つ
- **寿命の分離**: `pnpm build && bin/service restart`（Web の再デプロイ）は実行中ジョブに影響しない。runner 自身の再起動は resume で復旧
- ジョブ状態機械: `queued → running → waiting_input ⇄ running → done | failed | cancelled`

## ジョブの中身（発射 → PR）

入力は `{ repo: "yonda/cockpit", issueNumber }`。

1. **worktree 準備**: `git fetch origin main` 後、`git wt feature/<issue番号>-<slug>`（`../cockpit-wt/` 配下、既存の命名規則）。ブランチ/worktree が既に存在すれば再利用（再発射・リトライと同経路）
2. **プロンプト組み立て**: `gh issue view --json` で Issue 本文を取得し、「概要 / 成果物 / 作業詳細 / 完了後 draft PR 作成」のテンプレに整形
3. **SDK 実行**: worktree を cwd に `query()` を 1 回
   - `permissionMode: "acceptEdits"`（worktree 内の編集は自動許可）
   - `allowedTools`: 読み取り系・テスト実行・`git`・`gh pr create --draft` 等の定型を事前許可
   - それ以外の Bash・外部送信系・`AskUserQuestion` は `canUseTool` に落ち、cockpit へ転送
   - session_id は開始直後に状態ファイルへ保存（resume 用）
   - 進捗は hooks（`PostToolUse` 等）で拾いジョブイベントとして記録
4. **成果検証**: 終了後に runner が `gh pr list --head <branch>` で draft PR の存在を確認。エージェントの自己申告は信用しない
5. **後始末**: 成功・失敗とも worktree は残す（レビュー対応・原因調査に使う）。マージ後の worktree 削除は当面手動
6. **通知**: `done / failed / waiting_input` への遷移で PWA 通知 + 通知音（既存機構）

## 許可転送・質問回答

**runner 側** — `canUseTool(toolName, input)` で:

1. `pendingInput` を記録: `{ id, kind: "permission" | "question", toolName, input, createdAt }`
2. ジョブを `waiting_input` に遷移 → SSE + PWA 通知
3. Promise を保留したまま回答を待つ（タイムアウトなし）

**UI 側（ジョブカード内）**:

- permission: ツール名 + 内容の要約（Bash はコマンド全文、Write はパスと差分サイズ）。「許可」「拒否（理由入力可）」
- question: `questions` / `options` をボタン群にレンダリング（multiSelect・自由入力対応）

**回答経路**: ブラウザ → `POST /api/jobs/:id/respond` → ソケット → runner が Promise を resolve → SDK 続行。localhost・単一ユーザーのため認可レイヤーは設けない。

**エッジケース**:

- 回答前に runner が再起動: ツール未実行のまま transcript に残るため、`resume` で SDK が同じ許可を再要求する想定。**実装時に実機検証必須**。再要求されない場合は「resume + 状況説明プロンプト」でリカバリ
- 放置: 待ち続ける。カードに経過時間を表示、ジョブのキャンセルで打ち切り
- 同一 Issue への二重発射: アクティブなジョブがある間は発射ボタンを無効化

## UI（`/launch`）

NavTabs に `Launch` タブを追加。既存画面は変更しない。

- **Issue リスト**（上段）: `lib/github/client.ts` で open Issue を取得。番号・タイトル・ラベル・⚡ボタン
- **ジョブ一覧**（下段）: 状態ピル（PaneCard の statusConfig と同系デザイン）、対象 Issue、ブランチ、経過時間、直近アクティビティ（session_id から `lib/claude/recap.ts` を再利用）、`waiting_input` の承認/回答 UI、`done` の PR リンク、実行中のキャンセルボタン
- **リアルタイム**: `/api/jobs/events` が runner のイベントを SSE 中継（`/api/panes/events` と同パターン）

## エラー処理

- runner 停止中: `/launch` はセクション単位のエラー表示（SectionBoundary + オフライン自動回復を流用）
- ジョブ失敗: エラー要約・worktree パス・transcript 末尾をカードに表示。「再発射」は同じブランチ・worktree を再利用
- launchd 環境: runner の plist に PATH（homebrew / mise shims）を明示。`bin/service runner-status` に `git wt` / `gh` のヘルスチェックを含める

## テスト

- runner のジョブ状態機械・永続化・再起動復旧・ソケットプロトコルを単体テスト。SDK は `AgentExecutor` インターフェイスに切り出しフェイクで差し替える（vitest 導入 — 本リポジトリ初のテスト基盤）
- SDK 実機の結合テストは自動化せず、dogfood で手動検証: 些細な Issue で発射し、許可転送・質問回答・PR 作成・runner 再起動からの resume を確認

## デプロイ

- runner は esbuild で単一ファイルにバンドルし node で実行
- `bin/service` に `runner-install / runner-uninstall / runner-restart / runner-status` を追加（`com.cockpit.runner`、3 つ目の launchd サービス）
- 反映: UI は `pnpm build && bin/service restart`、runner は `pnpm build:runner && bin/service runner-restart`

## スコープ外（将来）

- 他リポジトリへの一般化（リポジトリごとのセットアップ吸収）
- 起案 UI・Claude による Issue 文面整形
- Agents ボードへの headless ジョブ統合表示
- マージ後の worktree 自動削除
- レビューコメント対応ワークフロー等、Issue 実装以外の定型ワークフロー
