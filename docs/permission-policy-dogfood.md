# permission-policy dogfood 検証メモ (Issue #25)

反転後の許可モデル (default-allow + 危険操作のみ cockpit へ転送) について、
実 PBI ジョブのツール実行ストリームで「通常作業がプロンプトフリーになる」
「危険操作は転送される」を検証し、見つかった過剰転送・判定漏れを
`runner/permission-policy.ts` のパターン補正として反映した記録。

実施日: 2026-07-12 / 対象 Issue: #25 (依存: #23 #24)

## 方法

runner が実行した implement ジョブ 12 本 (Issue #1〜#28、本 Issue #25 自身を含む)
の Claude Code transcript (`~/.claude/projects/<worktree>/**.jsonl`) から
全 tool_use イベント (計 244 件、検証セッション進行分を含む最終計測では 267 件)
を抽出し、同一ストリームを次の 2 つで replay して許可プロンプト発生数を比較した。

- **before**: 反転前の allowlist モデル
  (`allowedTools: Read/Glob/Grep/TodoWrite/Task/Bash(git:*)/Bash(gh issue view:*)/
  Bash(gh pr create --draft:*)/Bash(gh pr list:*)/Bash(pnpm:*)` + `acceptEdits`)
- **after**: 反転後の `evaluateToolUse` (permission-policy)

なお、この検証を行った Issue #25 のジョブ自身が「実機で流した PBI 1 本」であり、
稼働中の runner は反転前ビルドだったため、before 側のプロンプト洪水
(調査系 Bash がほぼ全て転送される) は実機でもそのまま観測された。

## 結果 (before / after)

| ジョブ | tool_use | before プロンプト | after 転送 (補正後) |
|---|---|---|---|
| #1 | 28 | 17 | 1 (main への force push) |
| #4 | 24 | 19 | 0 |
| #11 | 16 | 11 | 0 |
| #12 | 19 | 12 | 0 |
| #13 | 17 | 7 | 0 |
| #14 | 18 | 6 | 0 |
| #15 | 13 | 5 | 0 |
| #23 | 21 | 10 | 0 |
| #24 | 18 | 7 | 0 |
| #27 | 11 | 7 | 0 |
| #28 | 29 | 10 | 0 |
| #25 (本ジョブ) | 53 | 32 | 2 (メタ作業の for ループ) |
| **合計** | **267** | **143** | **3** |

- 通常の実装作業 (コード編集・pnpm test/lint/build・commit・feature ブランチへの
  push・draft PR 作成) は **転送ゼロ** になった。
- 残った転送 3 件はすべて妥当:
  - #1 の `git push origin <sha>:refs/heads/main --force-with-lease=...`
    (実際に起きた main 巻き戻し操作。**転送されるべき危険操作を正しく捕捉**)
  - #25 の `for` ループ 2 件 (worktree 外のジョブストアを読むメタ作業。
    ループ構文は静的解析の対象外とする fail-safe を維持)

## パターン補正前の転送 45 件の分類

補正前の permission-policy では同じストリームで 45 件が転送されていた。内訳:

| 分類 | 件数 | 判定 | 対応 |
|---|---|---|---|
| heredoc / `$(cat <<'EOF')` による commit メッセージ・PR 本文作成 | 22 | 過剰転送 | 静的に安全な heredoc を解析対象に追加 |
| `git -C <自分の worktree>` | 8 | 過剰転送 | -C が worktree 内を指す場合は許可 |
| `cd <自分の worktree>` | 6 | 過剰転送 | 移動先が worktree 内の cd を許可 |
| `npx tsc` / `npx eslint` | 2 | 過剰転送 | 既知 dev ツールの allowlist 方式で許可 |
| `python3 -c` (読み取りスクリプト) | 2 | 過剰転送 | node と同じ割り切りで許可 |
| `find \| xargs grep` | 1 | 過剰転送 | xargs の実行コマンドを再帰判定 |
| `ps` | 1 | 過剰転送 | 読み取り系として許可 |
| `for` ループ (メタ作業) | 2 | fail-safe 維持 | 対応せず (転送のまま) |
| main への force push (#1 の実事故) | 1 | **真に危険** | 転送のまま (正しい挙動) |

**判定漏れ (危険なのに auto-allow) は、実データ上は 0 件だった。**
新モデルで新たに auto-allow になる操作を全件確認したが、pnpm 系・読み取り系・
feature ブランチへの push のみで、危険操作の取りこぼしは無かった。

## 補正内容 (runner/permission-policy.ts)

### 緩和 (過剰転送の解消)

1. **heredoc**: `<<'EOF'` (quoted delimiter) は本文をリテラルとして解析。
   unquoted (`<<EOF`) は本文に `$(` / バッククォートを含む場合のみ転送。
   終端行が無い heredoc は従来どおり転送 (fail-safe)。
2. **`$(cat <<'EOF' ... EOF)` コマンド置換**: commit メッセージ・PR 本文を
   組み立てる標準イディオムに限りリテラルとして解析。それ以外の `$()` は
   従来どおり転送。
3. **行継続 (`\` + 改行) とコメント行 (`#`)**: 解析可能に (複数行コマンド対応)。
4. **`cd`**: 移動先が worktree 内のときのみ許可。worktree 内へ cd した後は、
   以降の相対パスを worktree ルート基準で解決しても「外なのに内」と
   誤判定することはない (深い cwd からの `..` の方が常に内側に留まる)。
5. **`git -C`**: worktree 自身 (またはその配下) を指す場合のみ許可。
6. **リダイレクト書き込み先に `/tmp` 配下を追加** (PR 本文の一時ファイル慣習)。
   `rm` 等の破壊操作の対象は従来どおり worktree 内に限定。
7. **`xargs`**: 実行コマンド部分を再帰判定 (`xargs grep` は許可、
   `xargs rm` / `xargs sh -c` は転送)。
8. **安全コマンド追加**: `python3` `ps` `set` `sleep`。
   `npx` は `tsc` / `eslint` / `prettier` / `vitest` のみ許可
   (`-p` / `--package` / `-c` 指定と未知パッケージは転送)。

### 締め (判定漏れの予防)

dogfood データ上の判定漏れは 0 件だったが、blanket allow だった git の中に
worktree 外へ副作用が及ぶものがあるため予防的に締めた:

9. **`git worktree`**: `list` 以外 (add/remove/prune 等) は転送
   (他ジョブの worktree を破壊し得る)。`git wt` も引数なし (一覧) のみ許可。
10. **`git config --global` / `--system`**: 転送
    (`core.fsmonitor` や alias 書き換えで任意実行につながる)。

対応テスト: `runner/__tests__/permission-policy.test.ts` は 79 → 104 ケース
(本補正分 +25)。`pnpm vitest run` 全 247 テスト通過。

## dogfood 中に見つかった permission-policy 以外の問題 (follow-up 推奨)

1. **許可転送の並行競合バグ**: 実装エージェントが並列に 2 つの Bash を実行し
   両方が転送対象になると、runner が
   `invalid transition: waiting_input -> waiting_input` で 2 件目の転送に失敗する
   (本ジョブで実際に発生)。pendingInput が単一スロット前提になっているため、
   キュー化または直列化が必要。
2. **デプロイ注意**: 稼働中の runner (dist/runner.cjs) は反転前ビルドだった。
   permission-policy を実機に効かせるには `pnpm build:runner` + launchd の
   kickstart が必要 (本 PR マージ後の反映を忘れないこと)。

## 再現方法

transcript の tool_use を旧 allowlist / 新 evaluateToolUse の両方に通す
replay スクリプトで計測した (ジョブの sessionId・ローカルパスを含むため
リポジトリには含めていない。`~/.cache/cockpit/jobs/*.json` の worktreePath と
sessionId から `~/.claude/projects/` の transcript を特定し、assistant
メッセージの tool_use ブロックを抽出して評価する、という手順)。
