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

設定の置き場所は当初 **spawn 時の `claude --settings <file>`** としていた:

| 置き場所 | 問題 |
|---|---|
| `~/.claude/settings.json` | 人間自身の普段のセッションにも掛かる |
| worktree の `.claude/settings.json` | エージェント自身が書き換えられる (fail-closed が崩れる) |
| spawn 時 `--settings` (当初採用) | ディスパッチャが管理しエージェントから不可侵。現行の「コードで配線」と同じ保証 |

**2026-07-14 改訂 (#85): この判断は覆した。** 「人間自身の普段のセッションにも
掛かる」を問題ではなく目的 (実行環境の統一) と再定義し、
`~/.claude/settings.json` を全セッション共通の唯一のプロファイルにする。
fail-closed の保証は「注入」から「起動時検証」(runner/profile-check.ts) へ移した。
詳細は後段「実行環境の統一」を参照。

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

**2026-07-14 改訂: 却下の根拠を実測に差し替えた。** 当初の根拠は
「sandbox 除外の `gh` が人間の認証で動く以上、merge / branch 削除 /
任意 `gh api` 書き込みを止めるものが何もなくなる」だったが、これは
runner 用 fine-grained PAT (#54) の導入で失効している。現在有効な却下理由は
実測 (後段「実行環境の統一」の実測表) で得たこの 1 点:

**`bypassPermissions` は Seatbelt の封じ込めごと無効化する。**
deny rules は bypass 下でも強制されるが、sandbox の allowedDomains 外への
ネットワーク送信が素通りになることを実測した (対照の acceptEdits + sandbox
では proxy 403 で封じ込め成功)。無人実行の安全性の本丸は sandbox による
構造的封じ込めなので、それを失う bypass は採れない。
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

## 実行環境の統一 (2026-07-14 改訂, Issue #85)

### 問題: プロファイルを分けると「退化」が生まれる

HerdrExecutor の初期実装は runner 専用 settings
(`runner/herdr-runner-settings.json`) を `--settings` で注入していた。
「無人だから危険 → 引き算で安全に」の発想で組んだ結果、マネージャーが CLI で
付き添う auto-mode セッションより**弱い**エージェントに、対話より**難しい**
(無人の) 仕事をさせる形になっていた:

1. 層 2 (提出) 未配線 — `git push` / `gh pr create` すら承認待ち (#81)
2. 安全チェックに引っかかる複合ワンライナーで承認待ち停止 (#75)。
   #79 はプロンプト誘導によるソフト対処で構造保証がなかった
3. `Skill` の全面 deny — 普段のセッション品質を作っている資産
   (スキル・プラグイン) の没収。本文書の「人間と同じ資産をそのまま使える」
   という核心文と矛盾していた
4. `rm` の全面 deny — sandbox が構造的に封じ込める操作の二重禁止

プロファイルを分ける限り、対話側との差分 (退化) をひとつずつ潰す消耗戦になる。

### 原則: 実行プロファイルは一つ

> マネージャーが端末 (wezterm + herdr) で自分で開くセッションも、
> cockpit (runner) が kick するセッションも、**同じユーザー settings・
> 同じ資産・同じ自由度**で動く。「不要に許可を求められない自走性」は
> runner の性質ではなく **CLI そのものの性質**として作り込む。
> cockpit は (1) kick できる (2) 可視化できる、という上に乗る任意レイヤー。

人間のリアルタイム監視が担っていた機能だけを構造で置換する:

- 統合・外界の門番 → 層 3 deny + fine-grained PAT + ブランチ保護 + sandbox
- 異変への気づき → `Notification` hook → cockpit 受信箱 (移行パス step 4)

あわせて規律を明文化する: **制御は settings / hooks / GitHub 構造に置く。
プロンプト文言は説明には使ってよいが、保証には使わない。** プロンプト文言で
しか塞げない穴は負債として issue 化し、CLI アップグレード時に再検証する
(#79 の「1 コマンドずつ」誘導は Notification hook 導入後に削除する負債)。

### 実測結果 (claude CLI v2.1.207, `-p` + settings)

| # | 実験 | 結果 |
|---|---|---|
| 1 | #75 の決定的ブロック複合コマンド + 構成コマンドの allow | **無承認で通る** (対照: allow なし = BLOCKED)。複合はセグメント分解で評価され、全セグメント許可なら複合のまま通る |
| 2 | `defaultMode: bypassPermissions` + deny `Bash(rm:*)` | deny は bypass 下でも強制される (rm ブロック実測) |
| 3 | bypass + sandbox で allowedDomains 外へ curl | **素通り = 封じ込め喪失**。対照 (acceptEdits + sandbox) は proxy 403 で封じ込め成功 → bypass 却下の現行根拠 |
| 4 | allow ルールで許可した curl を allowedDomains 外へ | **封じ込め成功** (403)。allow はプロンプトを飛ばすだけで実行は Seatbelt 内 → ローカル完結コマンドの allow は封じ込めを損なわない |
| 5 | 統一プロファイル適用後のグローバル settings (注入なし) | 複合検証コマンド無承認 / `gh pr merge` deny / allowedDomains 外 curl 封じ込め、の 3 点合格 |

### 統一プロファイルの構成 (~/.claude/settings.json)

- `defaultMode: acceptEdits` + `sandbox.enabled` + `autoAllowBashIfSandboxed`
  (層 1: sandbox に収まる作業は無承認)
- allow: 提出系 (`git push` / `gh pr create` / gh 読み取り) + 検証系
  (`pnpm` / `npx` / `node`) + 複合コマンドの従属セグメント頻出ユーティリティ
  (実測 4 により封じ込め非破壊)
- deny (層 3、profile-check の REQUIRED_DENY と同一表記): `Bash(gh pr merge:*)`
  `Bash(gh pr ready:*)` `Bash(git push --force:*)` `Bash(git push --force-with-lease:*)`
  `Bash(git push -f:*)`。prefix 照合は近似ガード (フラグの位置違いは捕まえられない)
  で、force push の本丸は GitHub 側のブランチ保護。Skill / rm は deny しない (退化の撤廃)
- sandbox `excludedCommands`: `gh` に加え `git push/fetch/pull/clone`
  (SSH remote のリポジトリで鍵と網が必要なため。鍵は sandbox 内の
  他コマンドからは読めないまま)
- `additionalDirectories` に worktree 親ディレクトリを含める
  (メインリポのセッションから `git wt` する運用が cwd 外書き込みになるため)

### fail-closed の置き場所: 注入 → 検証

runner は settings を注入しない代わりに、`runner/profile-check.ts` が
ユーザー settings の不変条件を検証する:

- **安全性**: 層 3 deny の存在・sandbox 有効 (fail-closed)・
  network.allowedDomains 非空・credentials deny (~/.ssh 等)・bypass でない・
  広すぎる allow (素の Bash / gh / git / gh api、表記ゆらぎ込み) がない
- **完走性**: 層 2 allow の存在・acceptEdits・autoAllowBashIfSandboxed
  (欠けても危険ではないが、無人ジョブが誰も見ない承認待ちで無音停止する)

検証は **デーモン起動時 + ジョブ spawn 毎** に行う (起動後に settings が
壊された場合も次のジョブから止める)。違反時は SdkExecutor に degrade せず
デーモンごと停止する — 違反検出時にこそ旧プロファイルの実行系が復活する
二重状態を許さない。不変条件そのものの退行は
`runner/__tests__/profile-check.test.ts` が守る。

トレードオフとして、ユーザー settings は人間がいつでも書き換えられる
(注入方式のような不可侵性はない)。これは「人間の環境が真実であり、
runner はそれを検証して従う」という統一思想の帰結として受け入れる。
エージェント自身による書き換えは sandbox (cwd 外書き込み遮断) が防ぐ。

### 残課題 (統一後も残る gap)

- **worktree 側 settings による上書き**: spawn された claude は
  `<worktree>/.claude/settings(.local).json` もマージ評価し、runner が
  trust を事前付与するためその allow が有効になる。sandbox は cwd 内書き込みを
  許すので、エージェント自身がジョブ中に allow を広げる経路が理論上残る
  (統一以前の trust 運用から存在する既知ギャップ)。被害半径は fine-grained
  PAT (対象リポ限定・merge 不可) とブランチ保護で拘束される。恒久対策は
  follow-up issue で検討 (spawn 時の worktree settings 検査等)
- **異変への気づき**: Notification hook → cockpit 通知 (移行パス step 4)。
  これが入るまで、残余の承認待ちは「無音のブロック」になり得る
- **記憶**: auto-memory (`~/.claude/projects/<cwd>/memory`) は cwd 単位の
  ため worktree ジョブに引き継がれない
- **MCP・WebFetch の外界送信**: 対話とのパリティを優先して許可を維持。
  無人時の exfiltration 経路としては未封鎖 (既知のリスクとして記録)
- KPI の再解釈: 「プロンプト = 文字通り 0」を追うとプロンプト誘導のような
  ハックに向かう。正しくは (a) 正常ジョブの無人完走率、
  (b) 残余ブロックが無音で固まらないこと
