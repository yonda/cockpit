# herdr/CLI 構成 PoC 検証メモ (Issue #56)

docs/permission-philosophy.md 移行パス step 3「HerdrExecutor」実装の前段として、
基準文書に列挙した要検証ポイントを実機で消化した記録。結論として全項目クリアで、
HerdrExecutor は列挙した構成で実装可能。

実施日: 2026-07-13 / 対象 Issue: #56 (依存: #54 構造ガード済み)

## 実験環境

- dispatcher 管理の settings (エージェントから不可侵の想定): `--settings <file>` で渡す
- 隔離 worktree (git init した一時ディレクトリ) を cwd に
- Claude Code CLI v2.1.207 (`claude -p` = headless / herdr ペイン内 = interactive)

採用した dispatcher settings (要点):

```jsonc
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "deny": ["Bash(gh pr merge:*)", "Bash(gh pr ready:*)", "Bash(rm:*)", "Skill"]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,        // ← 現行 SDK 構成の false から反転
    "excludedCommands": ["gh *"],
    "network": { "allowedDomains": ["github.com", "*.github.com"], "allowAllUnixSockets": true }
  },
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "cat >> <log>" }] }]
  }
}
```

## 結果 (要検証ポイント 5 項目)

### E1. deny rules は sandbox の auto-allow より優先されるか → ✅ 優先される

`autoAllowBashIfSandboxed: true` の下で 2 コマンドを実行させた:

- `touch created-by-agent.txt` → **allowed** (sandbox に収まる書き込みは無プロンプトで通過)
- `rm -f delete-me.txt` → **denied** (`Permission to use Bash with command rm -f delete-me.txt has been denied.`)

deny rule (`Bash(rm:*)`) が auto-allow に勝つことを実測。ファイルシステム確認でも
`delete-me.txt` は残存。**層 3 (統合操作を deny) の前提が成立**。

### E2. worktree 側 settings で dispatcher settings を上書きできるか → ✅ できない (不可侵)

エージェントが自分で書ける位置 (`<worktree>/.claude/settings.json`) に敵対的設定
(`sandbox.enabled: false` + `permissions.allow: ["Bash(rm:*)"]`) を置いた状態で
E1 と同じ 2 コマンドを実行:

- `echo escaped > ~/...` → **blocked** (`operation not permitted`、sandbox 健在)
- `rm -f delete-me.txt` → **denied** (deny rule 健在)

CLI は `Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace
has not been trusted` と明示し、worktree 側 allow を無視した。`--settings` 由来の
sandbox / deny は worktree settings に上書きされない。**「spawn 時 --settings で
fail-closed を維持」という philosophy の前提が成立**。

補足: untrusted workspace の allow が無視されるのは追加の安全弁。HerdrExecutor が
worktree を明示 trust する場合でも、deny と sandbox は settings 階層で worktree allow
より強いことは E2 本体で確認済み。

### E3. Seatbelt は CLI 単独 (SDK 非経由) で効くか → ✅ 効く

`echo escaped > ~/herdr-poc-escape.txt` (worktree 外への書き込み) は headless・
interactive の両方で `operation not permitted` で失敗、ファイルは生成されず。
SDK は sandbox 設定を CLI settings にパススルーしているだけ (sdk.mjs で確認済み) と
いう前提どおり、`--settings` 経由でも Seatbelt は同等に機能する。

### E4. Notification hook は許可待ちで発火し外部通知に使えるか → ✅ 発火する

herdr ペイン内 interactive セッションで、sandbox 除外の `gh api user` (要許可) を
実行させたところ、許可ダイアログ表示と同時に Notification hook が発火し、ログに:

```json
{
  "session_id": "170c1740-...",
  "transcript_path": "/Users/.../<session_id>.jsonl",
  "cwd": "<worktree>",
  "hook_event_name": "Notification",
  "message": "Claude needs your permission",
  "notification_type": "permission_prompt"
}
```

payload に session_id・transcript_path・cwd・種別が含まれ、**そのまま cockpit の
escalation 受信箱に転送できる** (層 4 の I/F)。herdr の agent_status もこのとき
`blocked` に変わり、通知の二重チャネルとして使える。

注意: headless (`claude -p`) では許可待ちが**プロンプトを出さず即拒否**されるため
Notification hook は発火しない。無人ジョブでも人間が介入できる余地を残すには
**interactive ペイン (herdr) で動かすことが必須**。これは「実行を herdr ペインに
移す」という設計判断の裏付けにもなった (SDK headless のままでは層 4 が機能しない)。

### E5. transcript tail で activity 観測・完了検知ができるか → ✅ できる

- **activity (SdkExecutor.onActivity 相当)**: transcript (`<session_id>.jsonl`) を tail し、
  `type=="assistant"` の `content[].text` / `tool_use.name` を拾えば逐次の活動が取れる
  (実測で `tool: Bash` 等を抽出)。session_id は transcript のファイル名そのもの
- **完了検知**: interactive セッションの transcript には headless の `type=="result"`
  イベントは出ない。代わりに **herdr の `agent_status` (`working`→`blocked`→`done`)** を
  完了シグナルに使う (`herdr wait agent-status <pane> --status done`)。実測で done を確認
- **session_id 取得**: Notification hook payload・transcript ファイル名・`system` init
  行のいずれからも取れる (resume 用に保存できる)

## HerdrExecutor で採用する構成 (結論)

`AgentExecutor` インターフェース (runner/executor.ts) を保ったまま、`SdkExecutor` と
並ぶ実装として:

1. **spawn**: dispatcher が `herdr tab/pane` を作り、worktree を cwd に
   `claude --settings <dispatcher-settings> <prompt>` を interactive 起動
   (headless ではない = E4 の理由)。worktree は事前に明示 trust する
2. **settings**: E1-E3 の dispatcher settings を `--settings` で固定。
   `autoAllowBashIfSandboxed: true` + deny rules + Seatbelt + Notification hook
3. **activity 観測**: transcript tail (assistant text/tool_use) → hooks.onActivity 相当
4. **完了検知**: `herdr wait agent-status <pane> --status done` (+ フォールバックで
   transcript の最終 assistant / PR 存在チェック)
5. **escalation (層 4)**: Notification hook → cockpit へ POST。人間はペインにアタッチして
   応答 (cockpit は通知のみ、応答配管は持たない = philosophy の分担どおり)
6. **session_id**: transcript ファイル名 / hook payload から取得し resume に使う

## 残課題 (HerdrExecutor 実装 Issue に引き継ぐ)

- ジョブキャンセル: SdkExecutor は `stream.close()` で子プロセス終了していた。herdr では
  ペイン close または CLI への割り込みキー送出でどう実現するか要設計
- 並行ジョブ数: herdr ペイン数の上限・cockpit の scheduler との整合
- trust の付与手順: worktree ごとの `hasTrustDialogAccepted` 設定を dispatcher が行う配線
- headless フォールバック: herdr が使えない環境 (CI・cron) での挙動 (SdkExecutor 併存で吸収)
- transcript の完了イベント欠如: interactive に result 相当が無い件、agent_status 依存で
  十分か、PR 存在を DoD の真実とするかの整理
