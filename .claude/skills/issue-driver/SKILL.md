---
name: issue-driver
description: Use when you are handed a single GitHub issue and asked to drive it to completion on your own — understand it, implement it (decomposing and delegating to teammates if it is large), self-review, open PR(s), then stay alive monitoring the merge lifecycle (reacting to merges and review comments, retargeting stacked PRs, firing unblocked dependents) until the issue is fully resolved — pausing only to hand off for human review/merge or when you are genuinely stuck. Invoke at the start, before touching the issue.
---

# issue-driver

あなたは1つの GitHub issue を渡された。それを **完全に片付くまで（その issue の PR が全てマージされるまで）自走で drive** する。**draft PR を出したら終わり、ではない**——PR を出した後も生き続け、**マージ検知・レビューコメント検知**に反応してループを回し、最後まで運ぶ。人間がやるのは2つだけ：**成果物のレビューとマージ**（あなたを止める唯一の意味あるゲート）と、**本当に詰まった時の相談**。それ以外の判断・対応は全部自分でやる。

## 完走の定義

**その issue が完全に解決した状態** ＝ ソロなら「その PR がマージされた」、分解したなら「全 sub-task の PR がマージされた」。draft PR を出した時点は**途中**であり、そこから監視ループ（§7 監視ループ）で最後まで運ぶ。

**マージ自体は絶対にしない**（構造的に deny。マージは人間 or cockpit のボタン）。あなたは「マージを検知して反応する」だけ。

## 自走境界：何を自分で決め、いつ人間に聞くか

**自分で決める（相談しない）**：実装の方針・ライブラリ選定・命名・テスト設計・リファクタの範囲・エラー処理・レビュー指摘のトリアージ（直す/見送り）——要するに**実装上のあらゆる選択**。迷っても、根拠を持って自分で決めて進む。

**人間に聞く（エスカレーション）— 次の3つの時だけ**：

1. **仕様の矛盾**：issue の要求同士が両立しない、または要求がコードの現実と根本的に食い違う
2. **大きな外部影響**：破壊的変更・データ移行・公開 API 変更など、後戻りが重く影響範囲の大きい決定
3. **解けないブロッカー**：権限・認証・環境・依存の欠落など、自力で越えられない障害。ただし**即エスカレーションしない**——同じブロッカーに対して複数パターンの自己修復を試し、それでも解決しない時に初めて「解けない」と判定する（無限リトライも避ける）。

この3つ以外で止まってはいけない。「念のため確認」「どちらが好みか」で人間を止めない。エスカレーションする時は **状況・選択肢・あなたの推奨** を明確にして進捗ファイルに記録し（cockpit が赤表示する）、環境に通知手段があれば（agmsg 等）人間/lead に通知する。

## フロー

**進捗ファイルは各フェーズの必須ステップ**：以下の各ステップは末尾の「**→ 進捗ファイル**」で終わる。これは事後のブックキーピングではなく、cockpit がリアルタイムに状況（今どこ・詰まっているか）を見るための本質。実装に没入して書き忘れると観測契約が空洞化し、最後に done を一括生成するだけになる。各ステップの「→ 進捗ファイル」を**必ずその場で実行**すること（§進捗ファイル）。

**作業環境**：コード変更は worktree で行う（メインリポで直接作業しない）。worktree の作成・依存インストールは**ホスト/リポの規約（`CLAUDE.md`・パッケージマネージャ）に従う**。skill 側で特定コマンド（`git worktree add` / `git wt` / `npm` / `pnpm` 等）は指定しない——環境ごとに正しい手段が違う。フックの失敗などは規約側の既知事情の場合があるので、worktree ができていれば止めずにリカバリして進む。

### 1. 理解
- issue 本文・関連コード・リポジトリ規約（`AGENTS.md` / `CLAUDE.md` 等）を読む。**規約は必ず守る**（例：特定フレームワークの独自版なら該当 docs を先に読め、等）。
- 仕様が「本当に詰まる」ほど曖昧なら → エスカレーション条件1。そうでなければ**解釈を自分で確定**して進む。
- **→ 進捗ファイル**：初期化して `phase: "understanding"`、ノードを最低1個（issue 自身）作る。

### 2. 規模判断
- **小（単一の一貫した変更・1〜数ファイル・明確仕様）** → 分解せずソロで進む（ノード1個）。
- **大（複数の独立変更・広範・複数の受け入れ条件）** → 分解する。
- 目安：**変更が概ね 10 ファイルを超える**、または**独立にレビュー・マージできる塊が複数見える**なら「大」。迷ったら小から始め、実装中に大と分かったら分解に切り替えてよい。

### 3. 分解（大の時だけ）
- issue をサブタスクに割る。各サブタスクは「独立にレビュー・マージできる単位」。依存関係を明示。
- 分解ツリーを進捗ファイルに記録（`phase: "decomposing"`、各ノードに `dependsOn`）。
- サブタスクを **sub-issue 化**（GitHub）。以降、分解の確定形は GitHub が持つ（§観測契約）。
  - **落とし穴**：sub-issue 本文に作成順の仮 `#N` を書かない。GitHub が既存の無関係 issue に自動リンクしてしまう。依存は本文中の論理ラベル（"Task 1" 等）で表し、**全 sub-issue を作り終えてから**実番号で `gh issue edit --add-blocked-by` をまとめて設定する。
- **依存の扱い（並行 vs 直列を分ける）**：
  - **独立（並行可能）なサブタスク**：それぞれ `main` から切って別 PR で並行実装。互いに未マージのコードを前提にしない（衝突・ビルド破壊を防ぐ）。並行なら teammate を立てる（§teammates）。
  - **直列依存のサブタスク**（A→B→C のように前段の成果物に依存）：**「マージされるまで待つ」のではなく、依存元の未マージブランチに stack して進める**（B を A のブランチから切り、PR の `--base` を A のブランチにする）。マージは人間ゲートで run 中にはマージされない＝**待つと永久に詰まる**。stack で先へ進め、依存元がマージされたら **base を `main` に付け替え・依存を解除するのは §7 監視ループの仕事**。
- lead（あなた）は依存の解決・統合・レビュー、そして**マージ後の base 付け替えまで**を担う。

### 4. 実装
- **→ 進捗ファイル**：着手時に `phase: "implementing"`、対象ノードを `liveStatus: "implementing"` に。
- TDD と規約に沿って実装。**実装判断は全部自分で**。
- 小：あなた自身が実装。大：各 teammate が担当サブタスクを実装し、完了ごとに lead がレビュー。
- **→ 進捗ファイル**：意味のある進展のたびに対象ノードの `activity` を1行更新（cockpit がここを見て「今なにをしているか」を表示する）。書き忘れると cockpit からは実装フェーズが空白に見える。

### 5. セルフレビュー（superpowers 非依存・内蔵）
- **→ 進捗ファイル**：`phase: "reviewing"`、対象ノードを `liveStatus: "reviewing"` に。

まず **実行ゲート**：PR を出す前に、リポジトリの規約（README / CLAUDE.md 記載のコマンド）に従い **typecheck / lint / test / build を実際に実行して green を確認する**。**実行ゲートは変更内容にスケールさせる**——型・純ロジックのみの変更なら `typecheck`（`tsc` 等）＋該当 `test`、フレームワーク/ビルドに影響する変更なら `build` まで回す。関係するチェックは省かず、関係しないチェックは無理に回さない。落ちていれば直す。直せない場合はエスカレーション条件3として扱う。観点レビューだけで実行検証を省いて PR を出してはいけない。

その上で、自分の変更を次の観点で**自分で**通し、指摘をトリアージする：
- **バグ・正しさ**：エッジケース・エラー処理・並行性・境界値
- **仕様適合**：issue の受け入れ条件を全部満たすか。**過不足**（余計な機能を足していないか / 足りない要件はないか）
- **品質**：規約準拠・命名・重複・テストの有効性（何も検証していないテストは不可）

各指摘を **直す（バグ・明確な改善）** か **見送る（トレードオフのある設計判断）＋理由を記録** に振り分ける。見送りは PR 本文に残す。

### 6. PR を出す（まだ完走ではない）
- 各サブタスク（ソロなら1つ）の draft PR を作成（`gh pr create --draft`、issue と対応 sub-issue を参照）。見送った指摘・要判断点を PR 本文に明示。直列依存の PR は `--base` を依存元ブランチに（§3）。
- **→ 進捗ファイル**：該当ノードを `liveStatus: "handed_off"` ＋ `prNumber`。全ノードの PR が出たら `phase: "monitoring"`。
- **→ 進捗ファイル（監視の連絡先を残す）**：`phase: "monitoring"` に入るとき、トップレベルに **`session`（担当セッションの連絡先）** を書く（§進捗ファイルのスキーマ参照）。cockpit の wake 機構（#168）が「生きていれば つつく／死んでいたら 赤旗で可視化」を判断するのに使う。agmsg で協調しているなら自分のチーム名・エージェント名を、herdr 上なら pane・worktree の cwd を入れる。**この情報を残さないと cockpit はあなたを起こせない**（連絡先未記録は「起こせない＝死んだ」扱いになり保険側へ回る）。分からない項目は `null`。
- 人間に「レビュー・マージをどうぞ」と提示し、**§7 監視ループに入る**（停止しない）。

### 7. 監視ループ（親 issue が完全に片付くまで）
PR を出したら、**その issue の全 PR がマージされるまで生き続けて反応する**。ループの各周回で GitHub を reconcile し、以下に反応する：
- **PR がマージされた**：
  - その PR に stack していた依存 PR の `--base` を `main` に付け替える（GitHub の auto-retarget は不発のことがあるので手動で `gh pr edit <n> --base main`）。
  - その依存でブロックされていた次のサブタスクを発火・昇格する（依存が解けた）。
  - **→ 進捗ファイル**：該当ノード・依存ノードの `liveStatus` を更新。
- **レビューコメントが付いた**：内容に**コードで対応**（修正 → push）し、進捗ファイルに記録する。**人間コメントへのテキスト返信は投稿しない**（既定。対応はコード＋push で示す）。担当が teammate なら teammate に指示。
- **全 PR がマージされた**：`phase: "done"`。親 issue が閉じられる状態になったら完了。
- **詰まった**：3条件でエスカレーション。

**回し方（基盤非依存）**：ループは「一定間隔で GitHub を reconcile する」とだけ規定する。実際の起床（wake）は環境が提供する手段に委ねる。**自分でホットループを回して待たない**（トークンを浪費する）。1周 reconcile したら**待機に戻る**（herdr ペイン等で生きたまま idle。idle は入力待ちなのでトークンを食わない）。かつ **stateless-recoverable**：kill されても再 kick 時に GitHub＋進捗ファイルから状態を再構築してループを再開できること（§stateless-recoverable）。マージは絶対にしない——検知して反応するだけ。

**cockpit の wake 機構（#168）で起こされる**：cockpit は `phase: "monitoring"` の run を一定間隔で検知し、あなたが**生きて待機していれば** agmsg で「1周 reconcile して」と1通つついてくる。それを受けたら**この節のループを1周だけ**回して待機に戻る（つつきを合図に動く。自分でタイマーを持たない）。だから §6 で **`session` 連絡先を必ず残す**こと——これが「つつく先」になる。

**死んだら赤旗（保険）**：あなたが**死んでいたら**（セッション消滅・クラッシュ等）、cockpit はつつけないので進捗ファイルに **escalation（赤旗）を立てて可視化**し、人間/lead に「issue-driver を再起動して監視ループを引き継いで」と促す（無人での自動立て直しは現状しない＝静かに詰まらせない保険）。したがって **wake 手段の無い一発 subagent** として起動され、monitoring 中に生き続けられないと分かっているなら、`monitoring` で停止する前に**自分で escalation を書いておく**（「監視ループを継続できる主体がいない。人間/lead が引き継ぎを」）。黙って止まると、次の wake tick で cockpit 側が赤旗を立てるまで気づかれない。生きて待機できるなら、それが最善（つつかれて自走が続く）。

## 進捗ファイル（観測契約）

cockpit が「どの issue がどう分解され、今どういう状況か」を、平常時は WezTerm を覗かずに見るための機械可読な状態。

**置き場所**：`~/.cache/cockpit/runs/<repo-slug>/<issueNumber>.json`（`<repo-slug>` は `owner/name` の `/` を `__` に置換）。ディレクトリが無ければ作る。

**原子的に書く**：**同じディレクトリ内**に一時ファイルを書いて `mv` で置換する（同一 FS 内の rename は原子的）。cockpit が読みかけを掴まないため。system tmpdir（`mktemp`）はサンドボックスで弾かれる（`Operation not permitted`）ことがあるので使わず、書き込み先と同ディレクトリの `.tmp` にする。
```bash
tmp="${path}.tmp"; printf '%s' "$json" > "$tmp"; mv "$tmp" "$path"
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
  "phase": "understanding | decomposing | implementing | reviewing | monitoring | done | escalated",
  "updatedAt": "<ISO8601>",
  "escalation": null,   // または { "reason": "spec_conflict|external_impact|blocker", "detail": "…", "options": ["…"], "recommendation": "…", "at": "<ISO8601>" }
  "session": null,      // 監視の連絡先(§6 で phase:monitoring に入るとき記録)。cockpit の wake 機構(#168)が「つつく/赤旗」判断に使う。無ければ null
                        // 例: { "agmsgTeam": "cockpit", "agmsgAgent": "cockpit-G", "herdrPane": "wE:p1F", "cwd": "/…/cockpit-wt/feature/168" } — 不明な項目は null
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
同一 issue に対して lead が**同時に2つ**起動されると（cockpit の kill/再 kick の誤り等）、両者が並行して worktree/ブランチを作り衝突する。これを防ぐため、GitHub 側に**排他専用**の軽量ロック信号を持つ：起動時に issue へ作業中を示すラベル（例: `issue-driver:active`）を付け、**既に付いていれば別 lead が作業中**と判断して停止するか引き継ぎを確認する。完走/中止時に外す。**ロックは親 issue だけに付ける**（sub-issue には付けない——排他の単位は「1 issue = 1 lead」なので親で足りる）。これは状態のミラーではなく**ロックのためだけ**に使う（「1事実=1つの持ち主」原則を崩さない例外）。

## teammates の立て方（大きい issue）

- teammate の spawn は**環境が提供する手段**を使う（agmsg の spawn/send、または Task subagent 等）。特定の基盤に依存した書き方をしない。
- **worktree パスとブランチ名は lead が一意に採番して teammate に渡す**（teammate に自前生成させない）。並行 teammate が `$(date +%s)` 等で自前生成すると値が衝突し、同一ディレクトリで作業して互いの変更が混入する。命名は分解ツリー由来の一意キー（例: `issue-<issueNumber>/<subIssueNumber>`）にする。
- 各 teammate には担当サブタスク（対応する sub-issue）＋割り当てた worktree/ブランチを渡し、「実装 → セルフレビュー → draft PR → lead に報告」させる。**teammate は自己終了せず lead に結果（PR URL・サマリ）を報告**する。
- lead はサブタスク間の依存を管理し、報告を受けてレビューし、親 issue の完走可否を判断する。詰まった teammate の救出も lead の仕事（それでも越えられなければエスカレーション条件3）。

## やってはいけないこと

- 実装上の選択で人間を止める（エスカレーションは3条件だけ）
- マージする（人間の領分。検知して反応するだけ）
- draft PR を出した時点で「完走」と誤認して監視ループに入らず停止する（PR は途中。全マージまで運ぶ）
- 監視ループで人間コメントにテキスト返信を投稿する（対応はコード＋push で示す）
- 監視ループをホットループで回してトークンを浪費する（一定間隔 reconcile ＋ 再開可能に）
- 進捗ファイルに GitHub 権威の事実を複製する（drift の元）
- 進捗ファイルを非原子的に書く（cockpit が壊れた JSON を読む）
- 途中状態を記憶だけに持って外部に書かない（再開不能になる）
- 検証していないテストを書く / 受け入れ条件を勝手に削る・足す
