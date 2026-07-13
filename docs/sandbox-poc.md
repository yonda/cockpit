# Seatbelt (sandbox) PoC 実測メモ (Issue #36)

t2 (runner への SandboxSettings 導入) の実装前に潰すべき 4 つの要注意ポイント
(gh の TLS / autoAllowBashIfSandboxed と canUseTool の評価順 / pnpm install の
egress / failIfUnavailable) を、使い捨て PoC ハーネスで macOS 実機実測した記録。

実施日: 2026-07-12〜13 / 対象 Issue: #36
環境: macOS 15.7.4 (Seatbelt / sandbox-exec) / Node 22.19.0 /
`@anthropic-ai/claude-agent-sdk` 0.3.205 / pnpm 11.10.0

## 方法

`bin/sandbox-poc.mjs` (使い捨てハーネス。runner/ 本体には依存しない) で
`query({ options: { sandbox, canUseTool, permissionMode: "default", settingSources: [] } })`
を実験ごとの設定で起動し、固定のコマンド列を「1 コマンド = 1 Bash 呼び出し、
失敗しても回避・リトライ禁止」のプロンプトで実行させ、次の 3 点を JSONL 記録した。

- `canUseTool` 呼び出し (toolName / input) — 評価順の観測点
- assistant の `tool_use` (実行コマンドと `dangerouslyDisableSandbox` の有無)
- `tool_result` (OS レベル拒否メッセージの生データ)

canUseTool は「呼ばれたことをログして常に allow」(一部実験のみ
`SandboxNetworkAccess` を deny)。実験は計 12 セッション、約 $3.3。

## E1: 最小構成 `{ enabled: true }` の Seatbelt 挙動

cwd = `/tmp/sandbox-poc/e1` (scratch)。

| 操作 | 結果 |
|---|---|
| cwd 内への書き込み | OK |
| `$HOME` への書き込み / mkdir | **OS レベルで拒否** (`operation not permitted`) |
| `/tmp` 直下 (cwd 外) への書き込み | **OS レベルで拒否** |
| `~/.gitconfig` の読み取り | **通る** (読み取りはデフォルト広い) |
| `curl https://example.com` | プロキシが留めて **`SandboxNetworkAccess` として canUseTool に転送** → allow で 200 |
| 同上を canUseTool で deny (E1-deny) | `curl: (56) CONNECT tunnel failed, response 403` |
| プロキシ迂回 `curl --noproxy '*'` | DNS 解決から失敗 (`Could not resolve host`) |
| raw TCP (`python3 socket` で IP 直結) | `PermissionError: Operation not permitted` |

- ネットワークは **OS レベルでは全遮断**で、sandbox が localhost の許可プロキシ
  (`HTTP_PROXY`/`HTTPS_PROXY`/`GIT_SSH_COMMAND` 等を環境変数で注入。
  `SANDBOX_RUNTIME=1` も立つ) を唯一の経路として提供する。
  `network.allowedDomains` にないドメインは、遮断ではなく
  **疑似ツール `SandboxNetworkAccess` (input: `{host}`) として canUseTool に escalate**
  される。canUseTool を持つ runner 構成では「未許可ドメイン = cockpit へ転送」になる。
- `$TMPDIR` は `/tmp/claude-<uid>/...` に付け替えられ書き込み可。
- 読み取り制限はデフォルトでほぼ無い。`~/.gitconfig` が読めたことから、
  秘匿ファイルは `credentials.files` / `filesystem.denyRead` で明示的に守る必要がある。

## E2: autoAllowBashIfSandboxed と canUseTool の評価順

| 設定 | sandbox 化 Bash | 観測 |
|---|---|---|
| 未指定 (E1) | canUseTool に来ない | **デフォルトは true 相当** (SDK 0.3.205) |
| `false` (E2-off) | 書き込み系・push を含むチェーンは **必ず canUseTool に来る** | `echo > file`、`git init … && git push origin main --force` で確認 |
| `true` (E2-on) | canUseTool を **バイパス** | cwd 外書き込みの失敗も含め一切来ない |

- `false` でも `ls` / `git status` など読み取り系は CLI 組み込みの安全判定で
  canUseTool 前に auto-allow される。これは非 sandbox の現行 runner と同じ挙動で、
  push / 書き込みなど副作用のあるコマンドが canUseTool に来ることは実測どおり。
  **保護ブランチへの force push チェーンが canUseTool に到達することを確認**
  → Layer 0 (permission-policy) の捕捉経路は `false` で維持される。
- `true` でも完全バイパスではない: 静的解析で sandbox 化しても安全と言えない
  コマンド (raw socket を張る `python3 -c`、`rm -rf` を含むチェーン等) は
  true のまま canUseTool に escalate された。
- **`dangerouslyDisableSandbox: true` 付きの Bash は設定によらず必ず canUseTool に来る**
  (input にフラグがそのまま載る)。allow すると非 sandbox で実行され、
  cwd 外書き込みが成功した。sandbox 化できない Bash のフォールバック先は
  「モデルが自発的に dangerouslyDisableSandbox を付けて再試行 → canUseTool (Layer 0)」
  という経路になる。
  - **t2 実装項目**: 現行 `permission-policy.ts` は `input.command` しか見ないため、
    `input.dangerouslyDisableSandbox === true` を無条件 escalate に追加すること。
    これを怠ると「見た目が無害なコマンド + sandbox 解除」が auto-allow され得る。

## E3: gh の TLS と excludedCommands

| 構成 | `gh api` / `gh pr list` | 備考 |
|---|---|---|
| sandbox 下 (素) | **全滅**: `tls: failed to verify certificate: x509: OSStatus -26276` | Go が TLS 検証に使う `com.apple.trustd.agent` (Mach service) へ到達できない。同一ドメインへの curl は成功 |
| `excludedCommands: ["gh *"]` | **成功** (rate_limit / user / pr list) | gh は sandbox 外で実行される |

- **excluded な gh は `autoAllowBashIfSandboxed: true` でも canUseTool に戻る**
  (unsandboxed なので auto-allow の対象外)。`gh pr merge` 等の危険系を
  permission-policy が引き続き捕捉できる。issue の想定どおり
  `excludedCommands: ["gh *"]` で回避 + Layer 0 維持が成立する。
- `gh pr create` も同じ api.github.com への TLS スタック
  (`gh api` POST / GraphQL で代表確認)。PoC では実 PR は作っていない。
- 素の `git fetch` / `git push --dry-run` (https) は sandbox 下で**成功**した
  (E3-push、実 worktree で確認)。github.com が allowedDomains 未登録だと
  `SandboxNetworkAccess {host: github.com}` として escalate される。
  認証後に credential helper が keychain へ書き戻す処理だけ
  `fatal: failed to store: 100001` の警告を出すが exit 0 で無害。

## E4: pnpm install / build / test の egress・追加設定

- **pnpm install**: `network.allowedDomains: ["registry.npmjs.org"]` のみで成功
  (scratch: date-fns + esbuild / 実リポジトリ: `--frozen-lockfile`)。
  グローバル store (`~/Library/pnpm/store`) には書けず、pnpm が
  **cwd 内 `.pnpm-store/` に自動フォールバック**する (インストールは成功、
  worktree 間のキャッシュ共有だけ失われる)。共有したければ
  `filesystem.allowWrite: ["~/Library/pnpm"]` を足す (store 汚染と引き換え)。
- **pnpm test (vitest 257 件)**: `runner/__tests__/server.test.ts` の 6 件が
  `Error: listen EPERM: operation not permitted <tmp>/runner.sock` で失敗
  (Unix ドメインソケットの bind 遮断)。`network.allowLocalBinding: true` では
  **直らず**、`network.allowAllUnixSockets: true` で **257 件全通過**。
  テストのソケットパスは `mkdtemp` でランダムなため、パス指定の
  `allowUnixSockets` では現状絞れない。
- **pnpm lint**: sandbox 内外で結果が同一 (既存の 3 errors は origin/main 由来)。
- **pnpm build (next build)**: **sandbox 下では失敗**。next/font/google
  (`app/layout.tsx` の Manrope) がビルド時に Google Fonts を fetch するが、
  Node fetch (undici) はプロキシ環境変数を使わないため OS レベルで遮断される。
  - `fonts.googleapis.com` / `fonts.gstatic.com` を allowedDomains に入れても、
    `SandboxNetworkAccess` を allow しても失敗 (同一セッションの
    `curl https://fonts.googleapis.com/...` は 200 → プロキシ経路は生きており、
    プロキシ非対応クライアント固有の問題であることを切り分け済み)。
  - 非 sandbox で一度ビルドしてもフォントのオフラインキャッシュは残らず
    (Next 16.2.10 / Turbopack)、再実行しても同じ失敗。
- **pnpm build:runner (esbuild)**: ネットワーク不要で成功。

## E5: リンク worktree からの共有 .git 書き込み

scratch リポジトリ + `git worktree add` のリンク worktree を cwd にして実測。

- `git status` / `add` / `commit` / `branch` は **追加 filesystem.allowWrite なしで全て成功**。
  commit の objects / refs は cwd 外の親リポジトリ `.git` に書かれるが、
  sandbox がセッション起動時に git common dir を検出して許可している。
- 逆に、セッション開始後に cwd 直下で `git init` すると
  `.git: Operation not permitted` で失敗する (E2-off で観測)。`.git` は明示 deny で、
  起動時に判明しているリポジトリ構造のみ許可される挙動。
  runner は worktree 作成後にセッションを起動するので問題にならない。

## E0: failIfUnavailable

- options 経由で `enabled: true` を渡した場合のデフォルトは `true`
  (SDK 0.3.205 の型ドキュメントに明記。settings 経由のデフォルトは `false`)。
- macOS 実機では sandbox-exec が常に存在するため「起動時に依存不足で fail」の
  分岐は実測では発火させられない。代わりにネスト sandbox-exec 配下で起動して
  「Seatbelt を適用できない環境」を人工的に作ると、起動時エラーではなく
  **コマンド単位で `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71)**
  になり、`failIfUnavailable: false` でも同じだった。
  → 少なくとも macOS では「黙って非 sandbox 実行に降格する」経路は観測されず
  fail-closed。とはいえ将来の Linux 移植や依存欠落を考え、明示 `true` を推奨。

## 結論: t2 で採用する SandboxSettings

```jsonc
{
  "enabled": true,
  // 黙劇降格の禁止を明示 (options 経由のデフォルトと同値だが意図を固定)
  "failIfUnavailable": true,
  // Layer 0 (permission-policy) が全ての副作用系 Bash を見る現行モデルを維持。
  // デフォルトは true 相当なので明示 false が必須
  "autoAllowBashIfSandboxed": false,
  // gh (Go) は trustd 遮断で TLS 不能のため sandbox 除外。
  // excluded な gh は canUseTool に戻るので policy の捕捉は維持される
  "excludedCommands": ["gh *"],
  "network": {
    // install と git fetch/push。それ以外のドメインは SandboxNetworkAccess
    // として cockpit へ転送される (default-deny + 人間判断)
    "allowedDomains": ["registry.npmjs.org", "github.com"],
    // vitest (runner socket protocol) の UDS bind に必要。
    // パスがランダムなため当面は全許可 (follow-up 参照)
    "allowAllUnixSockets": true
  },
  "credentials": {
    // 読み取りがデフォルト広いことへの手当て (E1 で ~/.gitconfig が読めた)
    "files": [
      { "path": "~/.ssh", "mode": "deny" },
      { "path": "~/.aws", "mode": "deny" },
      { "path": "~/.config/gh", "mode": "deny" },
      { "path": "~/.netrc", "mode": "deny" }
    ],
    "envVars": [
      { "name": "GITHUB_TOKEN", "mode": "deny" },
      { "name": "ANTHROPIC_API_KEY", "mode": "deny" }
    ]
  }
  // filesystem: 追加 allowWrite は不要 (E5)。pnpm store 共有が欲しくなったら
  // "~/Library/pnpm" を allowWrite に足す選択肢はある (store 汚染と引き換え)
}
```

各値の根拠:

| 設定 | 値 | 根拠 (実測) |
|---|---|---|
| `failIfUnavailable` | `true` | E0。macOS では適用不能時もコマンド単位 fail-closed だが、降格禁止を明示 |
| `autoAllowBashIfSandboxed` | `false` | E2。true は canUseTool を完全バイパスし、保護ブランチ push の Layer 0 捕捉が消える。false で push チェーンの canUseTool 到達を実測。現行 policy が default-allow なので転送増のコストも小さい |
| `allowUnsandboxedCommands` | 既定 (`true`) のまま | E2。`dangerouslyDisableSandbox` は必ず canUseTool に来るので、policy 側で escalate すれば「人間が cockpit で判断して通す」脱出ハッチとして機能する。false だとフォールバック経路ごと消える |
| `excludedCommands` | `["gh *"]` | E3。TLS 回避 + excluded gh の canUseTool 復帰を実測 |
| `network.allowedDomains` | registry.npmjs.org, github.com | E4 (install 成功) / E3-push (git fetch/push)。fonts 系は入れても build が直らないので入れない |
| `network.allowAllUnixSockets` | `true` | E4。これが無いと pnpm test が 6 件落ちる。`allowLocalBinding` では直らない |
| `credentials` | 上記 | E1。読み取りはデフォルト広く、秘匿ファイルは明示 deny が必要 |
| `filesystem` | 追加なし | E5。リンク worktree の commit/branch は素で通る |

### t2 実装時の必須 follow-up

1. **permission-policy に `dangerouslyDisableSandbox` の escalate を追加** (E2)。
   これが無いと sandbox 解除付きの無害風コマンドが auto-allow され得る。
2. **DoD の `pnpm build` ゲートは agent の sandbox 内では実行不能** (E4)。
   next/font/google がプロキシ非対応 fetch を使うため。対応候補:
   runner 側 (非 sandbox) で build を実行する / フォントを自前ホスト化して
   ビルドのネットワーク依存を消す (別 Issue 推奨)。
3. `SandboxNetworkAccess` が canUseTool に来る (E1)。cockpit の転送 UI は
   toolName=Bash 以外に `SandboxNetworkAccess {host}` の表示に対応すること。
4. (任意) `server.test.ts` のソケットパスを worktree 配下の固定パスにできれば
   `allowAllUnixSockets` を `allowUnixSockets: [<パス>]` に絞れる。

## 再現方法

```bash
node bin/sandbox-poc.mjs e1            # 最小構成 (FS/ネットワーク/env)
POC_DENY_NET=1 node bin/sandbox-poc.mjs e1-deny   # egress deny + プロキシ迂回
node bin/sandbox-poc.mjs e2-off        # autoAllow false (push チェーン捕捉)
node bin/sandbox-poc.mjs e2-on         # autoAllow true (バイパス + escape hatch)
node bin/sandbox-poc.mjs e3-tls        # gh TLS 失敗
node bin/sandbox-poc.mjs e3-excl       # excludedCommands 回避
node bin/sandbox-poc.mjs e3-push "$PWD"          # git fetch/push --dry-run
POC_ALLOWED_DOMAINS=registry.npmjs.org node bin/sandbox-poc.mjs e4-pnpm
node bin/sandbox-poc.mjs e4-repo "$PWD"          # 実リポジトリ install/test/lint
POC_ALLOW_ALL_UNIX_SOCKETS=1 node bin/sandbox-poc.mjs e4-tests "$PWD"
node bin/sandbox-poc.mjs e4-build "$PWD"         # next build / esbuild
node bin/sandbox-poc.mjs e5-git /tmp/sandbox-poc/e5-main-wt/poc-branch
sandbox-exec -p '(version 1)(allow default)' node bin/sandbox-poc.mjs e0  # failIfUnavailable
```

E5 の scratch リポジトリは `git init` + `git worktree add` で用意する
(手順は本文参照)。各実行の生ログ (JSONL) は `/tmp/sandbox-poc/logs/` に残る。
