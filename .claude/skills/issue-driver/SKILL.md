---
name: issue-driver
description: Use when you are handed a single GitHub issue and asked to drive it to completion on your own — understand it, implement it (decomposing and delegating to teammates if it is large), self-review, and open a draft PR — pausing only to hand off the finished deliverable for human review or when you are genuinely stuck. Invoke at the start, before touching the issue.
---

# issue-driver

あなたは1つの GitHub issue を渡された。それを **draft PR まで自走で完走**させる。人間を止めるのは2箇所だけ：**完成した成果物（draft PR）を人間レビューに渡す時**と、**本当に詰まった時**。それ以外の判断は全部自分でやる。

## 完走の定義

「その issue を解決する draft PR を作り、進捗を記録し、人間のレビューに差し出して停止」した状態。**マージはしない**（マージは人間 or cockpit のボタン）。

## 自走境界：何を自分で決め、いつ人間に聞くか

**自分で決める（相談しない）**：実装の方針・ライブラリ選定・命名・テスト設計・リファクタの範囲・エラー処理・レビュー指摘のトリアージ（直す/見送り）——要するに**実装上のあらゆる選択**。迷っても、根拠を持って自分で決めて進む。

**人間に聞く（エスカレーション）— 次の3つの時だけ**：

1. **仕様の矛盾**：issue の要求同士が両立しない、または要求がコードの現実と根本的に食い違う
2. **大きな外部影響**：破壊的変更・データ移行・公開 API 変更など、後戻りが重く影響範囲の大きい決定
3. **解けないブロッカー**：権限・認証・環境・依存の欠落など、自力で越えられない障害。ただし**即エスカレーションしない**——同じブロッカーに対して複数パターンの自己修復を試し、それでも解決しない時に初めて「解けない」と判定する（無限リトライも避ける）。

この3つ以外で止まってはいけない。「念のため確認」「どちらが好みか」で人間を止めない。エスカレーションする時は **状況・選択肢・あなたの推奨** を明確にして進捗ファイルに記録し（cockpit が赤表示する）、環境に通知手段があれば（agmsg 等）人間/lead に通知する。

## フロー

### 1. 理解
- issue 本文・関連コード・リポジトリ規約（`AGENTS.md` / `CLAUDE.md` 等）を読む。**規約は必ず守る**（例：特定フレームワークの独自版なら該当 docs を先に読め、等）。
- 仕様が「本当に詰まる」ほど曖昧なら → エスカレーション条件1。そうでなければ**解釈を自分で確定**して進む。
- 進捗ファイルを初期化（§進捗ファイル）。`phase: "understanding"`。

### 2. 規模判断
- **小（単一の一貫した変更・1〜数ファイル・明確仕様）** → 分解せずソロで進む（ノード1個）。
- **大（複数の独立変更・広範・複数の受け入れ条件）** → 分解する。
- 目安：**変更が概ね 10 ファイルを超える**、または**独立にレビュー・マージできる塊が複数見える**なら「大」。迷ったら小から始め、実装中に大と分かったら分解に切り替えてよい。

### 3. 分解（大の時だけ）
- issue をサブタスクに割る。各サブタスクは「独立にレビュー・マージできる単位」。依存関係を明示。
- 分解ツリーを進捗ファイルに記録（`phase: "decomposing"`、各ノードに `dependsOn`）。
- サブタスクを **sub-issue 化**（GitHub）。以降、分解の確定形は GitHub が持つ（§観測契約）。
  - **落とし穴**：sub-issue 本文に作成順の仮 `#N` を書かない。GitHub が既存の無関係 issue に自動リンクしてしまう。依存は本文中の論理ラベル（"Task 1" 等）で表し、**全 sub-issue を作り終えてから**実番号で `gh issue edit --add-blocked-by` をまとめて設定する。
- **マージゲート**：`dependsOn` が非空のノードは、**依存先の PR がマージされるまで teammate を起動しない**（`liveStatus: "queued"` で待機）。未マージの依存コードを前提に並行実装すると、コンフリクト・ビルド破壊を招く。依存の無いサブタスクから **teammate を立てて**割り当てる（§teammates）。lead（あなた）は依存の解決・統合・レビューを担う。

### 4. 実装
- TDD と規約に沿って実装。**実装判断は全部自分で**。
- 小：あなた自身が実装。大：各 teammate が担当サブタスクを実装し、完了ごとに lead がレビュー。
- 進捗ファイルの該当ノードを随時更新（`liveStatus`, `activity`）。

### 5. セルフレビュー（superpowers 非依存・内蔵）
まず **実行ゲート**：PR を出す前に、リポジトリの規約（README / CLAUDE.md 記載のコマンド）に従い **typecheck / lint / test / build を実際に実行して green を確認する**。落ちていれば直す。直せない場合はエスカレーション条件3として扱う。観点レビューだけで実行検証を省いて PR を出してはいけない。

その上で、自分の変更を次の観点で**自分で**通し、指摘をトリアージする：
- **バグ・正しさ**：エッジケース・エラー処理・並行性・境界値
- **仕様適合**：issue の受け入れ条件を全部満たすか。**過不足**（余計な機能を足していないか / 足りない要件はないか）
- **品質**：規約準拠・命名・重複・テストの有効性（何も検証していないテストは不可）

各指摘を **直す（バグ・明確な改善）** か **見送る（トレードオフのある設計判断）＋理由を記録** に振り分ける。見送りは PR 本文に残す。

### 6. 完走
- draft PR を作成（`gh pr create --draft`、issue を参照）。見送った指摘・要判断点を PR 本文に明示。
- 進捗ファイルを最終状態へ（`phase: "done"`、該当ノードに `prNumber`）。
- 人間に成果物を提示して**停止**。マージはしない。

## 進捗ファイル（観測契約）

cockpit が「どの issue がどう分解され、今どういう状況か」を、平常時は WezTerm を覗かずに見るための機械可読な状態。

**置き場所**：`~/.cache/cockpit/runs/<repo-slug>/<issueNumber>.json`（`<repo-slug>` は `owner/name` の `/` を `__` に置換）。ディレクトリが無ければ作る。

**原子的に書く**：一時ファイルに書いて `mv` で置換する。cockpit が読みかけを掴まないため。
```bash
tmp="$(mktemp)"; printf '%s' "$json" > "$tmp"; mv "$tmp" "$path"
```

**更新契機**：フェーズ遷移・各ノードの状態変化・エスカレーションの発生/解消のたび。

**GitHub 権威の事実を複製しない**：PR がマージ済みか・レビュー状態・sub-issue の open/close は **GitHub が真実**。ファイルは `subIssue` / `prNumber` を**参照として持つだけ**で、マージ状態などは書かない（cockpit が GitHub から読んで join する）。

**スキーマ**：
```jsonc
{
  "schemaVersion": 1,
  "repo": "owner/name",
  "issueNumber": 70,
  "title": "…",
  "phase": "understanding | decomposing | implementing | reviewing | done | escalated",
  "updatedAt": "<ISO8601>",
  "escalation": null,   // または { "reason": "spec_conflict|external_impact|blocker", "detail": "…", "options": ["…"], "recommendation": "…", "at": "<ISO8601>" }
  "nodes": [
    {
      "key": "t1",
      "title": "…",
      "dependsOn": [],
      "liveStatus": "queued | implementing | reviewing | blocked | handed_off",
      "activity": "実装中: xxx を追加",   // 人が読む一行(任意)
      "subIssue": 71,                      // GitHub 参照(なければ null)
      "prNumber": 77,                      // GitHub 参照(なければ null)。マージ状態は書かない
      "escalation": null
    }
  ]
}
```
小さい issue は `nodes` が1個（issue そのもの）。

## stateless-recoverable（途中で死んでも再開できる）

あなた（lead）はいつ kill されても、続きから再開できなければならない。そのために：
- **途中状態をあなたの記憶だけに持たない**。真実は常に外部にある：**GitHub（issue / sub-issue / PR 状態＝永続骨格）＋ 進捗ファイル（ライブ層）**。
- 各フェーズは冪等に設計する：「まず GitHub と進捗ファイルから現在状態を再構築 → 次にやるべきことを1つ決めて実行 → 状態を書く」の繰り返し。
- 再 kick された時は、まず進捗ファイルと GitHub（`gh issue view` / 対応する sub-issue・PR）を読み、**どこまで終わっているかを判定してから**続きに入る。既に PR がある sub-issue を二重実装しない、等。
- **幽霊資源の後片付け**：kill 前に残った worktree や、まだ生きているかもしれない teammate セッションを再開時に検分する。進捗ファイルのノードに残した worktree パスが存在し、かつ対応 PR が未作成なら、不要な worktree として削除を検討してからやり直す（この作業メモは観測契約とは独立の再開用ハンドル）。

### 多重起動の排他（ロック専用シグナル）
同一 issue に対して lead が**同時に2つ**起動されると（cockpit の kill/再 kick の誤り等）、両者が並行して worktree/ブランチを作り衝突する。これを防ぐため、GitHub 側に**排他専用**の軽量ロック信号を持つ：起動時に issue へ作業中を示すラベル（例: `issue-driver:active`）を付け、**既に付いていれば別 lead が作業中**と判断して停止するか引き継ぎを確認する。完走/中止時に外す。これは状態のミラーではなく**ロックのためだけ**に使う（「1事実=1つの持ち主」原則を崩さない例外）。

## teammates の立て方（大きい issue）

- teammate の spawn は**環境が提供する手段**を使う（agmsg の spawn/send、または Task subagent 等）。特定の基盤に依存した書き方をしない。
- **worktree パスとブランチ名は lead が一意に採番して teammate に渡す**（teammate に自前生成させない）。並行 teammate が `$(date +%s)` 等で自前生成すると値が衝突し、同一ディレクトリで作業して互いの変更が混入する。命名は分解ツリー由来の一意キー（例: `issue-<issueNumber>/<subIssueNumber>`）にする。
- 各 teammate には担当サブタスク（対応する sub-issue）＋割り当てた worktree/ブランチを渡し、「実装 → セルフレビュー → draft PR → lead に報告」させる。**teammate は自己終了せず lead に結果（PR URL・サマリ）を報告**する。
- lead はサブタスク間の依存を管理し、報告を受けてレビューし、親 issue の完走可否を判断する。詰まった teammate の救出も lead の仕事（それでも越えられなければエスカレーション条件3）。

## やってはいけないこと

- 実装上の選択で人間を止める（エスカレーションは3条件だけ）
- マージする（人間の領分）
- 進捗ファイルに GitHub 権威の事実を複製する（drift の元）
- 進捗ファイルを非原子的に書く（cockpit が壊れた JSON を読む）
- 途中状態を記憶だけに持って外部に書かない（再開不能になる）
- 検証していないテストを書く / 受け入れ条件を勝手に削る・足す
