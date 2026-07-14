# issue-driver skill + 観測契約 設計

**日付**: 2026-07-14
**ステータス**: ドラフト（レビュー待ち）

## 背景：方針の大転換

これまで cockpit は「runner という常駐デーモンが、特別な settings を注入した特別なエージェントを spawn して回す」実行エンジンを作ってきた（HerdrExecutor / SdkExecutor / PBI 状態機械 / 4層権限モデル / サンドボックス注入）。

この方式は**許可地獄**に落ちた。安全なコマンド（lint / tsc / npx / git push / 複合ワンライナー / WebFetch / while ループ…）まで逐一許可を求められ、それを allow リストで塞ぐのは不可能（コマンドの種類は無限）。

一方、**同じ環境で人間が普段動かしている Claude Code エージェント（WezTerm + agmsg で協調するサブチーム）は一度も許可を聞かれない**。普通の Claude Code セッションとして、人間自身の設定で動いているから。

結論：**特別な実行エンジンを作るのをやめる。** 実行は `WezTerm + agmsg + Claude Code` の素の土台に戻す。縛らず、サブチームと同じ動かし方をする。作るべきは infra ではなく、**1 issue を渡されたら自走して完走する「振る舞い」= agent skill** と、その進捗を cockpit が可視化するための**観測契約**である。

権限問題はこの転換で**構造的に消える**。skill は特別プロファイルを使わず、人間の Claude Code 設定でそのまま動くため。

## スコープ：2つの成果物

1. **`issue-driver` skill**（仮称）— 1 issue を draft PR まで自走で完走する self-contained な agent skill
2. **観測契約** — skill が分解ツリーと進捗を機械可読に emit し、cockpit がそれを可視化する取り決め

cockpit（Web アプリ）自身は将来 **kick（issue ごとに herdr プロセスを立て skill を起動）+ レンズ（可視化）** に徹する。本 spec は skill と観測契約が主対象で、cockpit UI の実装は後続。

---

## 1. `issue-driver` skill

### 役割
1 つの issue（GitHub issue）を渡されたら、理解 → 実装 →（必要なら分解して並行）→ セルフレビュー → draft PR 作成、までを**自走で完走**する。人間タッチは2点だけ：**(a) 最後の成果物（draft PR）のレビュー**、**(b) 本当に詰まった時のエスカレーション**。

### 設計原則
- **自己完結・controllable**：superpowers など外部 skill に依存しない。振る舞いを全部この skill の中に明示的に書き、フルにチューニング可能にする。
- **基盤非依存**：cockpit が kick しても、人間が手で起動しても、agmsg セッションで回しても同じに動く。特定の実行基盤（runner / herdr の特定構成）に依存しない。
- **権限に触れない**：起動側の Claude Code 設定でそのまま動く。skill 自身は権限モードや settings を変更しない。
- **規模適応**：小さい issue はソロでその場で実装、大きい issue は中で分解して teammates を立てて並行。issue の規模を skill が自分で判断する。
- **stateless-recoverable（#107 由来）**：lead（skill を回すエージェント）はいつ死んでも、**GitHub（永続骨格：issue / sub-issue / PR 状態）＋進捗ファイル（ライブ層）を読み直して続きから再開できる**こと。skill の各フェーズは「現在状態を外部（GitHub＋ファイル）から再構築 → 次にやるべきことを決定」という冪等な形にし、途中状態をエージェントの記憶だけに持たない。cockpit が kill/再 kick しても、人間が別セッションで拾い直しても、同じ issue の続きを回せる。

### フロー

```
1. 理解
   - issue 本文・関連コード・規約(AGENTS.md 等)を読む
   - 仕様が「本当に詰まる」ほど曖昧なら → エスカレーション(§自走境界)
   - それ以外は解釈を自分で確定して進む

2. 規模判断 → 分解(必要時のみ)
   - 小: 1 issue = 1 実装単位。分解せずソロで進む
   - 大: サブタスクに分解。分解ツリーを進捗ファイルに記録(§観測契約)
     - 分解が確定したらサブタスクを sub-issue 化(GitHub)
     - teammates を agmsg で立て、各サブタスクを割り当てて並行実装
     - lead(この skill を回すエージェント)が統合とレビューを担当

3. 実装
   - TDD・規約遵守で実装。実装判断は全部自分で(相談しない)
   - 各サブタスク完了ごとにレビュー(大の場合)

4. セルフレビュー
   - ローカル /code-review 相当を実行し、指摘を自分でトリアージ
     (修正すべき=直す / 見送り=理由を記録)

5. 完走
   - draft PR を作成(issue 参照)。進捗ファイルを最終状態に更新
   - 成果物を人間のレビューに差し出して停止(マージはしない=人間)

* いつでも: 本当に詰まったら → エスカレーション
```

### 自走境界（人間タッチの2点）

**(a) 成果物レビュー**：完走の定義は「draft PR を出して人間レビューに渡す」。マージは従来どおり人間（or cockpit のボタン）。

**(b) エスカレーション（本当に詰まった時だけ）**：以下に限る。実装の細かい選択は**一切相談せず自分で決める**。
- 仕様の**矛盾**（issue の要求同士が両立しない、コードの現実と食い違う）
- **大きな外部影響**の判断（破壊的変更・データ移行・公開 API 変更など、後戻りが重い決定）
- **解けないブロッカー**（権限・認証・環境・依存の欠落など、自力で越えられない）

エスカレーション時は、**状況・選択肢・推奨を明確にして**進捗ファイルに記録し（cockpit が赤く表示）、必要なら agmsg で人間/lead に通知する。

### teammates の立て方（大きい issue）
- lead はサブタスクごとに teammate エージェントを立てる（agmsg 経由、または Task/subagent。実行基盤に応じて。本 skill は「立てて割り当て、結果を統合し、レビューする」という振る舞いを規定し、具体的な spawn 手段は基盤に委ねる）
- 各 teammate は担当サブタスクを実装 → セルフレビュー → draft PR → lead に報告（自己終了しない、Agent Team ルール準拠）
- lead はサブタスク間の依存を管理し、統合・レビュー・親 issue の完走判断を行う

---

## 2. 観測契約（skill ↔ cockpit）

cockpit が「どの issue がどう分解され、各々が今どういう状況か」を、**平常時は WezTerm を覗かずに**見られるようにする。詰まった（赤）時だけ人間が WezTerm を覗く。

### 原則：1事実 = 1つの持ち主（二重管理を避ける）

| 事実 | 正の持ち主 | 理由 |
|---|---|---|
| 分解の**確定形**（各ノード = sub-issue） | **GitHub** | 永続・GitHub 上でも見える・PR が紐付く公式記録 |
| 各ノードの**成果物 PR**（存在・レビュー・mergeable・マージ済み） | **GitHub** | コード成果物とマージ生涯の権威。複製すると drift する |
| issue の **done**（close） | **GitHub** | 同上 |
| 各ノードの**ライブ状態**（実装中/レビュー中/詰まった） | **進捗ファイル** | GitHub が持たない。秒単位で変わる。GitHub に書くとレート制限＆ノイズ |
| **詰まった理由**（エスカレーション内容） | **進捗ファイル** | 「WezTerm を覗くべき理由」。cockpit がこれを赤表示 |
| **提案中でまだ sub-issue 化していない分解** | **進捗ファイル** | GitHub オブジェクトになる前の状態 |
| **ノード ↔ GitHub（sub-issue# / PR#）対応表** | **進捗ファイル** | 2つを join する鍵 |

**drift 防止**：進捗ファイルは GitHub が権威な事実を**複製しない**。PR のマージ状態は file に書かず、file はノードの PR# を**参照するだけ**。マージ状態は cockpit が GitHub から読む。

### 進捗ファイルのスキーマ（案）

issue ごとに 1 ファイル、機械可読（JSON）。置き場所は cockpit が跨プロセスで読める既知の場所（例: `~/.cache/cockpit/runs/<repo>/<issueNumber>.json`。最終決定は plan 段階）。

```jsonc
{
  "schemaVersion": 1,
  "repo": "owner/name",
  "issueNumber": 70,
  "title": "…",
  "phase": "understanding | decomposing | implementing | reviewing | done | escalated",
  "updatedAt": "2026-07-14T06:00:00Z",   // skill が更新のたびに書く
  "escalation": null,                     // または { reason, options, recommendation, at }
  "nodes": [                              // 分解ツリー(小の issue は 1 ノード)
    {
      "key": "t1",
      "title": "…",
      "dependsOn": [],
      "liveStatus": "queued | implementing | reviewing | blocked | handed_off",
      "activity": "実装中: xxx を追加",     // 人が読む一行(任意)
      "subIssue": 71,                      // GitHub 参照(なければ null)
      "prNumber": 77,                      // GitHub 参照(なければ null)。マージ状態は含めない
      "escalation": null
    }
  ]
}
```

cockpit は PR/sub-issue の**確定状態を GitHub から**、**ライブ状態を本ファイルから**取り、`subIssue`/`prNumber` で join して描く。

### cockpit の描画（レンズ）
- issue ごとに分解ツリーを表示：各ノードに GitHub の PR 状態（open/レビュー/mergeable/merged）＋ 進捗ファイルのライブ状態（実装中/詰まった/…）を重ねる
- **エスカレーション（赤）を最上位に**：`escalation` が非 null のノード/issue を目立たせ、「WezTerm を覗くべき理由」を表示
- 平常時：cockpit だけで「#70 → t1(merged) / t2(実装中) / t3(⚠️詰まった: 理由)」が分かる

---

## 3. 非目標（out of scope）

- runner / HerdrExecutor / SdkExecutor / PBI 状態機械 / 4層権限 settings の**維持・改修**（これらは撤去対象。別途 cockpit-G が掃除）
- cockpit の kick UI・レンズ UI の実装（本 spec は skill と観測契約が主。UI は後続 spec/plan）
- 権限プロファイルの設計（skill は起動側設定で動く。統一プロファイルの扱いは別トラック）
- マージの自動化（マージは人間 or cockpit ボタン、従来どおり）

## 4. 要検証・オープン問題（plan 前に潰す）

1. **「1 herdr プロセス = 1 issue」の実現性**：herdr は通常「1インスタンス = 1ソケットで複数ワークスペース」。issue ごとに別プロセス（別ソケット）として立て cockpit から個別に指せるか、herdr の能力を実機確認する。← kick 機構の急所（ただし skill 自体はこれに非依存）
2. **teammate の spawn 手段**：agmsg で立てるか Task/subagent か。基盤依存部分をどこまで skill が抽象化するか
3. **進捗ファイルの置き場所と書き込み規律**：跨プロセス read の既知パス、書き込み頻度、部分更新の原子性（cockpit が読みかけを掴まない）
4. **sub-issue 化のタイミング**：分解確定＝即 sub-issue か、承認を挟むか。旧 PBI は承認ゲートがあった。新モデルでの扱い
5. **superpowers を使わない前提での、レビュー/計画の最低限の型**：self-contained に何を内蔵するか（TDD・セルフレビュー・トリアージの手順を skill 内に明示）

## 5. 段階（想定）
1. 本 spec レビュー・確定
2. skill 単体を先に作り、**この WezTerm + agmsg セッションで実 issue に対して回して検証**（cockpit の kick を待たない）
3. 観測契約（進捗ファイル）を skill に組み込み、cockpit のレンズ側で読んで描く
4. cockpit の kick（herdr プロセス起動）機構
