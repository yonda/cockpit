# issue-driver skill 実装計画

> **For agentic workers:** この計画は「prose の skill を書いて、実 issue で回して直す」ことが主で、通常のコード TDD とは形が違う。skill 本体（SKILL.md）はレビュー観点で検証し、進捗ファイルのヘルパー（あれば）だけ通常のテストを持つ。

**Goal:** 1 issue を渡されたら draft PR まで自走で完走する self-contained な `issue-driver` skill を作り、実 issue で回して検証する。

**Architecture:** skill は Markdown の振る舞い手順書（SKILL.md）。進捗は spec の観測契約に従い、issue ごとの JSON ファイルへ原子的に書く。cockpit のレンズ側読み取り・kick 機構は本計画のスコープ外（後続）。

**Tech Stack:** Claude Code skill（Markdown）、進捗ファイルは JSON（`~/.cache/cockpit/runs/<repo-slug>/<issueNumber>.json`）。

## Global Constraints

- **self-contained**：superpowers 等の外部 skill を runtime 依存にしない。TDD・レビュー・分解の型を SKILL.md 内に明示する
- **基盤非依存**：teammate の spawn 手段は「環境が提供するもの（agmsg の spawn.sh / send.sh、または Task subagent）」に委ねる書き方にする
- **権限に触れない**：skill は権限モード・settings を変更しない。起動側の設定で動く
- **進捗ファイルは原子的に書く**：一時ファイルに書いて `mv` で置換（cockpit が読みかけを掴まない）。GitHub 権威の事実（PR マージ状態等）は複製せず参照（PR#）だけ持つ
- **公開リポ鉄則**：SKILL.md・進捗ファイル例・commit・PR 本文に会社名(Findy)・実 org/repo 名・`/Users/honda.yohei` 絶対パス・個人メールを入れない。プレースホルダ使用
- 参照 spec: `docs/superpowers/specs/2026-07-14-issue-driver-skill-design.md`

---

### Task 1: `issue-driver` SKILL.md を書く（skill 本体）

**Files:**
- Create: `.claude/skills/issue-driver/SKILL.md`

**Deliverable:** 次を全て含む1つの SKILL.md。
- **frontmatter**：`name: issue-driver`、`description`（いつ使うか＝「GitHub issue を1つ渡されて、それを自走で draft PR まで完走させたいとき」）
- **役割と自走境界**：完走＝draft PR を人間レビューに出して停止。エスカレーションは3条件のみ（仕様矛盾／大きな外部影響／解けないブロッカー）。実装の細かい選択は一切相談せず自分で決める、を明示
- **フロー**：理解 → 規模判断 →（大なら）分解 → 実装 → セルフレビュー → 完走。各段の具体手順
- **規模適応**：小＝ソロでその場実装、大＝分解して teammates を立て並行＋統合＋レビュー
- **セルフレビューの型（superpowers 非依存で内蔵）**：実装後にローカルでレビュー観点（バグ・仕様適合・過不足）を自分で通し、指摘をトリアージ（直す/見送り＋理由記録）してから PR
- **teammate の立て方**：基盤が提供する spawn 手段を使う旨（agmsg spawn.sh / send.sh、または Task）。teammate は担当を実装→セルフレビュー→draft PR→lead へ報告、自己終了しない
- **進捗ファイルの書き込みプロトコル**：spec の JSON スキーマに従い、`~/.cache/cockpit/runs/<repo-slug>/<issueNumber>.json` を各フェーズ遷移・各ノード状態変化・エスカレーション発生/解消のたびに**原子的に**更新（temp→mv）。GitHub 権威事実は複製しない（sub-issue#/PR# を参照で持つ）
- **完走の締め**：draft PR を作成（issue 参照）、進捗ファイルを最終状態（phase=done or escalated）に更新、人間に成果物を提示して停止

**検証（レビュー観点。ユニットテストではなく spec 適合レビュー）:**
- [ ] spec の「自走境界の2点」「エスカレーション3条件」が漏れなく明文化されているか
- [ ] 進捗ファイルの書き込み契機・原子性・GitHub 非複製が SKILL.md に具体的に書かれているか
- [ ] superpowers への runtime 依存が無い（レビュー/分解の型が内蔵されている）か
- [ ] 基盤非依存（teammate spawn 手段を環境に委ねる書き方）か

- [ ] **Step 1: SKILL.md を書く**（上記 Deliverable の全項目）
- [ ] **Step 2: spec と突き合わせてセルフレビュー**（上記4観点。不足を補う）
- [ ] **Step 3: commit**

---

### Task 2: 実 issue で dogfood（小さい issue = ソロ経路）

**目的:** 分解を伴わない小さい issue を1本選び、この WezTerm + agmsg セッションで issue-driver を実際に回し、①draft PR まで完走する ②進捗ファイルが spec スキーマ通りに原子的に書かれる ③本当に詰まった時だけエスカレーションする、を確認する。分解/teammate 経路は次イテレーション（大きい issue）で検証するため、初回は**ソロ経路の完走**に絞ってリスクを下げる。

**Files:**
- 検証用に skill を発見可能にする（`.claude/skills/` 配置 or `~/.claude/skills/issue-driver` へ symlink）
- 変更なし（skill を回す）＋ 観測結果に基づく SKILL.md の微修正

**手順:**
- [ ] **Step 1: skill を発見可能にする**（配置 or symlink）し、`issue-driver` が起動できることを確認
- [ ] **Step 2: 小さい実 issue を1本選ぶ**（既存の自分アサイン issue から、単一ファイル/明確仕様のもの）
- [ ] **Step 3: issue-driver を回す**。理解→ソロ実装→セルフレビュー→draft PR まで自走させる
- [ ] **Step 4: 観測**：
  - draft PR が作られたか
  - 進捗ファイル `~/.cache/cockpit/runs/.../<n>.json` が spec スキーマ通りか（phase 遷移・node.liveStatus・原子的更新）
  - GitHub 権威事実を複製していないか（PR マージ状態を file に書いていない）
- [ ] **Step 5: エスカレーション経路の確認**：わざと曖昧さのある入力 or ブロッカーで、3条件のいずれかで停止し進捗ファイルに `escalation` が記録されることを確認（軽く1ケース）
- [ ] **Step 6: 観測に基づき SKILL.md を微修正** → commit

**受け入れ:**
- ソロ経路で issue を draft PR まで完走できる
- 進捗ファイルが spec スキーマ通り・原子的・GitHub 非複製
- 詰まった時だけエスカレーションし、その理由が進捗ファイルに残る

---

## スコープ外（後続イテレーション）
- 大きい issue の分解＋teammates 並行経路の検証（Task 2 の次）
- cockpit のレンズ側（進捗ファイル＋GitHub を join して描く UI）
- cockpit の kick 機構（issue ごとに herdr プロセスを立てる）＋ herdr 多重プロセスの実機確認
- sub-issue 化の承認ゲート要否の確定

## Self-Review（この計画のチェック）
- spec の2成果物のうち skill 本体（成果物1）と観測契約の書き込み側（成果物2の skill 側）を Task 1 でカバー。読み取り側（cockpit）はスコープ外と明記済みで整合
- placeholder なし（各 Task に具体的 Deliverable と検証）
- prose skill に TDD ステップを無理に当てず、レビュー観点＋実 dogfood で検証する形に右サイズ化
