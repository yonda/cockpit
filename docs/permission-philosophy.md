# 権限設計の思想 — マネージャーと開発チームのモデル

cockpit / runner の権限設計を「tool call ごとの承認」から
「成果物レビュー + 構造的ガード」へ転換するための思想ドキュメント。
2026-07-13 の設計議論の結論をまとめたもの。実装 Issue はこの文書を基準に切る。

## 背景・問題意識

現行の runner (SdkExecutor + permission-policy.ts) は fail-safe allowlist モデル:
「安全と証明できた操作だけ自動許可し、それ以外はすべて cockpit へ転送」。
dogfood (Issue #25, docs/permission-policy-dogfood.md) で過剰転送を補正したが、
それでも allowlist 漏れ (`awk` / `make` / 解析不能なコマンド連結等) が
人間への許可プロンプトとして届き続ける。

これは設計として「メンバーがコマンドを 1 個叩くたびにマネージャーが承認する」
モデルになっている。マネージャーがレビューしたいのは **成果物 (PR)** であって
**作業過程 (tool call)** ではない。ここが理想とのズレの本質。

## 思想: 現実のチームをそのまま写像する

人間の開発チームでは:

- メンバーは自分の作業環境で何をしようが誰にも許可を取らない
- ブランチを push して PR を出すのも許可不要。それが「成果物の提出」であり、
  レビューの入口
- main へのマージはレビューを通さないとできない。ただしこれは
  「毎回の承認依頼」ではなく **ブランチ保護という構造** で担保されている
- 会社の外への行為 (外部発信・他チームのリポジトリへの介入) だけは
  事前にマネージャーへ話を通す
- マネージャーは GitHub や Slack を覗けば状況がわかる。メンバーは
  「マネージャー向けに状態を送信する」ことを一切していない —
  **仕事の副産物がそのまま観測対象**

原則: **レビューは成果物に対して行い、作業には行わない。**
**許可プロンプトは承認フローではなく異常検知。**

## 4 層モデル

| 層 | 内容 | 制御方法 | 人間の関与 |
|---|---|---|---|
| 1. 作業 | worktree 内の編集・ビルド・テスト・任意コマンド | sandbox (Seatbelt) による構造的封じ込め | なし |
| 2. 提出 | feature ブランチ push・draft PR 作成 | 無条件許可 (成果物の提出経路そのもの) | なし |
| 3. 統合 | merge・`gh pr ready`・main への push・force push | **deny** (エージェントの権限から外す) | マネージャーが PR レビュー後に cockpit で実行するアクション |
| 4. 外界 | 外部ホストへの送信・許可外ドメイン・他リポジトリ操作 | 原則遮断、例外のみ escalate | まれな例外承認 |

ポイントは層 3 の再定義。現行は「merge しようとしたら escalate (許可プロンプト)」
だが、思想的にはエージェントは merge を **試みる必要すらない**。merge は
レビューの帰結としてマネージャーが行うアクションであって、エージェントの
作業の延長ではない。よって「ask」ではなく「deny + cockpit UI にマージボタン」が正しい形。
人間チームのブランチ保護が「承認依頼」ではなく「構造」であるのと同じ。

この整理により、正常ジョブで発生する許可プロンプトは **0 件** になる
(層 4 は正常ジョブでは発生しない)。プロンプトが来た = 逸脱の検知、に意味が変わる。

**KPI: 正常な実装ジョブ 1 本あたりの許可プロンプト発生数 = 0。**

## アーキテクチャの再定義: cockpit は実行基盤ではなくレンズ

現行は SDK hooks (`onActivity` / `requestInput`) でエージェントの状態を
cockpit の DB に流し込む構造 = cockpit がメディア (伝送路) を兼ねている。
これを次の 3 層に再定義する:

```
実行層:  herdr ペイン内の Claude Code CLI セッション
         (人間と同じ環境・スキル・プラグイン・settings)
状態層:  GitHub (PR / issue / CI) + agmsg (チーム内会話)
         + transcript (~/.claude/projects) + herdr socket (ペイン状態)
観測層:  cockpit = 状態層を読む web UI + 意思決定アクション
         (merge ボタン・escalation 受信箱)
```

- 「覗きに行く」が本物になる: cockpit で異変に気づいたら herdr のペインに
  アタッチして、そのまま話しかけられる
- エージェントが人間と同じ Claude Code になり、普段の資産
  (スキル・設定・sandbox) をそのまま使える
- cockpit が薄くなる: GitHub と transcript が真実。cockpit が壊れても
  観測が止まるだけで実行は止まらない

runner には既に `AgentExecutor` インターフェース (runner/executor.ts) が
あるため、全書き換えではなく **`SdkExecutor` と並ぶ `HerdrExecutor`
(herdr にペインを spawn して transcript を tail する実装) の追加**で移行できる。
runner 自体は「SDK を抱く実行基盤」から「セッションを spawn する薄い
ディスパッチャ + DoD ゲート」に縮退する。

## ブロック時の I/F: cockpit で気づき、CLI で応答する

- **cockpit** = 「判断が要る」に気づく場所 (受信箱・通知)。一方向の通知のみ
- **CLI (ペイン)** = 実際に許可/拒否を応答する場所。アタッチして文脈ごと見て判断

現行の pending-input 機構 (cockpit → runner → canUseTool への応答配管) は
丸ごと不要になる。実装は Claude Code の `Notification` hook (許可待ちで発火)
から cockpit へ POST するだけ。「通知は cockpit に集約する」方針
(hooks 再設計の宿題) ともここで合流する。

## 権限設計の CLI settings への落とし込み

| 層 | 実装 | 正常時のプロンプト |
|---|---|---|
| 1. 作業 | `sandbox.enabled: true` + `autoAllowBashIfSandboxed: true` + `permissionMode: acceptEdits` | ゼロ (sandbox に収まる Bash と worktree 内 Edit は無条件通過) |
| 2. 提出 | allow rules: `Bash(git push:*)` `Bash(gh pr create:*)` `Bash(gh issue view:*)` 等の安全 gh サブセット | ゼロ |
| 3. 統合 | deny rules: `Bash(gh pr merge:*)` `Bash(gh pr ready:*)` `Bash(git push --force:*)` 等 | ゼロ (deny は即拒否でプロンプト自体出ない) |
| 4. 外界 | sandbox `allowedDomains` 外 → `SandboxNetworkAccess` プロンプト。WebFetch / WebSearch → ask | ここだけ人間 |

`autoAllowBashIfSandboxed` を現行 (sandbox-config.ts) で false にしている理由は
「canUseTool (Layer 0) に全 Bash を見せるため」だが、新構成では canUseTool
自体が消えるため **true への反転がまさにこの思想の実装**になる。

`permission-policy.ts` の精密なコマンド解析 (refspec 解析・heredoc パース等) は
この構成では不要になり、役割は次の「構造ガード」と粗い deny rules に引き継ぐ。

## Seatbelt (sandbox) の載せ替え

Seatbelt は Agent SDK の機能ではなく **Claude Code CLI 本体の settings 機能**。
SDK は `sandbox` オプションを CLI へ渡す settings JSON の `"sandbox"` キーに
詰め替えているだけ (sdk.mjs の設定マージ関数で確認済み。エラーメッセージにも
"Include the sandbox configuration in your settings file instead." と明記)。

よって herdr/CLI 構成でも `buildSandboxSettings()` の内容 (docs/sandbox-poc.md の
実測結論: gh の sandbox 除外、allowedDomains、credentials deny、
allowAllUnixSockets 等) はそのまま活かせる。`allowAllUnixSockets: true` は
herdr ソケット・agmsg にもそのまま必要。

設定の置き場所は **spawn 時の `claude --settings <file>`** とする:

| 置き場所 | 問題 |
|---|---|
| `~/.claude/settings.json` | 人間自身の普段のセッションにも掛かる |
| worktree の `.claude/settings.json` | エージェント自身が書き換えられる (fail-closed が崩れる) |
| **spawn 時 `--settings` (採用)** | ディスパッチャが管理しエージェントから不可侵。現行の「コードで配線」と同じ保証 |

注意: SDK は `enabled: true` かつ `failIfUnavailable` 未指定のとき自動で
true を補っていた。CLI 直接運用では **明示的に `failIfUnavailable: true` を書く**。

## 構造ガード: 層 3 は settings ではなく構造で二重化する

prefix ベースの deny rules は permission-policy.ts ほど精密ではないため、
本丸は GitHub 側の構造に置く:

1. **main のブランチ保護** (PR 必須): エージェントが push を試みても GitHub が
   拒否する。settings のすり抜けを心配しなくてよくなる
2. **runner 用 fine-grained PAT** (対象リポジトリ限定・merge 権限なし):
   `gh` は sandbox 除外 (TLS 問題) で認証済みのまま動くため、現状は
   「人間のトークンが届く全リポジトリ」が理論上の被害範囲。トークン側を
   弱めることで `gh` の穴そのものを小さくする

この 2 つが入れば settings の deny rules は二重目の柵となり、
「policy で頑張って守る」から「構造上できない」へ移行できる。

## 完全 auto (bypassPermissions) を採らない理由

ローカルの対話利用で auto mode が安全なのは **人間自身がリアルタイム監視
レイヤーだから** (目の前の画面、いつでも中断できる)。無人 runner には
その監視がなく、特に sandbox 除外の `gh` が人間の認証で動く以上、
merge / branch 削除 / 任意 `gh api` 書き込みを止めるものが何もなくなる。
上記の 4 層モデル + 構造ガードで「体感 auto (正常時プロンプト 0)」を実現し、
逸脱時だけ検知が働く状態を目指す。

## PoC での要検証ポイント

- [ ] deny rules が `autoAllowBashIfSandboxed: true` の auto-allow より
      優先評価されること (層 3 の前提)
- [ ] `--settings` で渡した sandbox 設定がセッション中に worktree 側
      settings で上書きされないこと
- [ ] `Notification` hook が許可待ち (SandboxNetworkAccess 含む) で
      確実に発火し、cockpit への通知に使えること
- [ ] herdr ペイン内の CLI セッションで Seatbelt が実際に効くこと
      (sandbox-poc.md E0〜E5 の再現)
- [ ] transcript tail による activity 観測が SdkExecutor の hooks 相当の
      情報を賄えること

## 現行実装からの移行パス

1. この文書のレビュー・合意 (本 PR)
2. GitHub 構造ガード: main ブランチ保護 + runner 用 fine-grained PAT
3. `HerdrExecutor` の試作: PBI ジョブ 1 本を herdr ペインで実行し、
   SdkExecutor と比較 (要検証ポイントの消化)
4. `Notification` hook → cockpit 通知の配線 (pending-input 機構の置き換え)
5. cockpit の読み取りソースを runner DB 中心 → GitHub 中心へ寄せる
   (実行層の移行と独立に価値がある)
6. SdkExecutor / permission-policy.ts の退役判断
