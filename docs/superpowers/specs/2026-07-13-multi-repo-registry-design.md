# マルチリポジトリ対応（リポジトリレジストリ）設計

runner を「単一リポジトリ専用」から「レジストリ駆動の複数リポジトリ対応」へ拡張し、
外部 org（仕事用リポジトリ）の実 PBI を HerdrExecutor で回せるようにする設計。

実施日: 2026-07-13 / 関連: docs/permission-philosophy.md, docs/herdr-cli-poc.md

## 背景・動機

現状の runner は単一の `REPO_DIR`（`COCKPIT_REPO_DIR ?? process.cwd()`）に固定されている。
`job.fire` は `repo` パラメータを受け取るが、実際の worktree・git・gh 操作はすべてこの
1 つの `repoDir` で行われ、ベースブランチも `origin/main` にハードコードされている
（runner/workflow.ts の ensureWorktree）。

「実 PBI を仕事用リポジトリで回す」には、runner に複数リポジトリを教える仕組みが要る。
各リポジトリは配置パス・ベースブランチ・認証が異なるため、これは設定変更ではなく
マルチリポジトリという実機能になる。

前提（対話で確定）:
- 仕事用 org コードを個人環境の自律エージェントで扱う運用は**認可済み・制約なし**。
  よって Docker per-job 隔離は必須要件ではなく、既存の Seatbelt sandbox（Layer 1）で始める。
- 認証は **org 所有の fine-grained PAT を登録リポジトリに限定**して使う
  （構造ガードの「最小スコープ」思想を維持。仕事用 org 全体には広げない）。
- スコープは**レジストリ全体**（複数リポジトリを登録できる仕組みを作る）。
- 登録は**設定ファイル**（登録 UI は今回作らない）。
- ローカルクローンは既存のものを使う（利用者は既に各リポジトリを clone 済み）。

## 公開リポジトリの鉄則

cockpit は公開リポジトリ（github.com/yonda/cockpit）である。したがって:
- **コードは完全に汎用**。特定の会社名・org 名・リポジトリ名・絶対パス・個人トークンを
  ソースに一切含めない。
- 仕事用 org 固有の情報（リポジトリ名・ローカルパス・トークン）はすべて
  `~/.config/cockpit/` 配下の外部ファイル（git 管理外）に置く。
- 本 spec・テストもプレースホルダ（`acme/widget` 等）で書く。

## アーキテクチャ

現状の「単一 REPO_DIR」を**リポジトリレジストリ駆動**に置き換える。cockpit 自身も
レジストリの 1 エントリにして経路を一本化する（単一リポ専用コードを残さない）。

```
job.fire(repo) → registry.resolveRepo(repo) → { path, baseBranch, tokenOwner }
                                                   │
        ┌──────────────────────────────────────────┼───────────────────────┐
        ▼                        ▼                   ▼                       ▼
  worktree を path 配下に    origin/<baseBranch>   token = resolveToken(   git/gh は
  作成 (ensureWorktree)      を起点にブランチ       tokenOwner)            その token で実行
                                                   (owner 別ファイル)      (herdr ペインにも供給)
```

## コンポーネント

### 1. リポジトリレジストリ `runner/repo-registry.ts`（新規）

- `~/.config/cockpit/repos.json`（パスは `COCKPIT_REPOS_FILE` で上書き可、テスト用）を読む。
- スキーマ:
  ```jsonc
  {
    "repos": [
      { "repo": "yonda/cockpit", "path": "<abs>", "baseBranch": "main",    "tokenOwner": "yonda" },
      { "repo": "acme/widget",   "path": "<abs>", "baseBranch": "develop", "tokenOwner": "acme"  }
    ]
  }
  ```
- API: `loadRegistry(file?) → Registry`、`registry.resolve(repo) → RepoConfig | null`。
- **fail-closed**: `job.fire` の repo がレジストリに無ければジョブを失敗させる
  （未登録リポジトリを勝手に既定リポジトリで実行しない）。
- 各フィールド検証: `path` は絶対パスかつ存在するディレクトリ、`baseBranch`/`tokenOwner` は
  非空。不正エントリは起動時に検出してログ + そのエントリを無効化（他エントリは活かす）。

### 2. owner 別トークン解決 `runner/github-token.ts`（改修）

- 現状: boot 時に `applyRunnerToken()` が単一トークンを `process.env.GH_TOKEN` にグローバル設定。
- 変更: `resolveToken(owner) → string` に置き換え。`~/.config/cockpit/tokens/<owner>`
  （`COCKPIT_TOKENS_DIR` で上書き可）を読む。fail-closed（欠如・空・複数行は throw、
  既存 loadRunnerToken と同じ検証を流用）。
- 後方互換: 既存の単一 `~/.config/cockpit/runner-token` は `~/.config/cockpit/tokens/yonda`
  へ移行する（移行手順は Deploy セクション）。
- **グローバル env は使わない**: owner ごとに異なるため、ジョブ単位で解決してそのジョブの
  git/gh 呼び出しにのみ渡す。boot 時の `applyRunnerToken()` 呼び出しは撤廃。

### 3. runner の配線 `runner/main.ts` / `runner/workflow.ts` / `runner/github.ts`

- `main.ts`: 単一 `REPO_DIR` 前提を撤廃し、レジストリをロードして依存に配線。
  `COCKPIT_REPO_DIR` は廃止（レジストリが真実）。
- `workflow.ts`（ensureWorktree）: `deps.repoDir` + `origin/main` 固定 →
  レジストリの `path` を cwd に、`origin/<baseBranch>` を起点にブランチ作成。
  worktree ルートは従来どおり `../{repo basename}-wt/`。
- `github.ts`（gh 呼び出し）: 対象リポジトリの owner トークンを `GH_TOKEN` として
  その呼び出しの env に渡す。方式は `CommandRunner.run` の opts に任意の `env`
  上書き（`Record<string,string>`、既定 env にマージ）を追加し、gh/git 呼び出し側で
  `{ env: { GH_TOKEN: token } }` を渡す。呼び出しごとに env を指定できるため、
  owner の異なるジョブが並行してもトークンが混ざらない。

### 4. HerdrExecutor へのトークン供給 `runner/herdr-executor.ts` / `runner/herdr-real.ts`

- herdr ペインは herdr インスタンスの env を継承し、runner の env は継承しない。
  よってジョブの owner トークンをペイン起動コマンドに明示的に渡す。
- `ExecutorRunOpts` に `githubToken: string | null` を追加。workflow がジョブの
  owner トークンを解決して渡す。
- `RealHerdrClient.startAgent` はペイン起動時に `GH_TOKEN=<token> claude --settings …`
  形（トークンは shell-quote）でトークンを供給する。
- 分解ジョブ（pbi-lifecycle, SdkExecutor）も同様に、対象リポジトリの owner トークンを
  子プロセス env に渡す。

### 5. 隔離・dispatcher settings

- 既存の Seatbelt sandbox（`runner/herdr-runner-settings.json`）をグローバル共有のまま使う。
  リポジトリ別の network 許可ドメイン等は将来の拡張（本 spec のスコープ外）。
- Docker per-job 隔離もスコープ外（認可・制約なしの前提のため）。

## データフロー（実装ジョブ）

1. `job.fire({repo, issueNumber, issueTitle})` → Job 作成（既存）。
2. scheduler がジョブを実行 → workflow が `registry.resolve(repo)` で `RepoConfig` 取得。
   未登録なら即 `failed`（fail-closed）。
3. `resolveToken(config.tokenOwner)` で owner トークン取得。欠如なら `failed`。
4. ensureWorktree: `config.path` で `git fetch origin <baseBranch>` →
   `origin/<baseBranch>` 起点に feature ブランチの worktree を作成。
5. executor 実行: HerdrExecutor に `githubToken` を渡す → ペイン起動時に `GH_TOKEN` 供給。
6. エージェントが実装 → `git push`（feature ブランチ）→ `gh pr create --draft`。
   push/gh は owner トークンで動く。
7. 完了検知 → 以降は既存フロー（PR ゲート・マージ検知）。

## エラーハンドリング

- レジストリ未登録リポジトリ: ジョブを `failed`（理由を error に明記）。デーモンは落とさない。
- owner トークン欠如・不正: ジョブを `failed`（理由明記）。他 owner のジョブは動く。
- repos.json 自体が読めない/壊れている: 起動時にエラーログ、レジストリ空で起動
  （全 `job.fire` が fail-closed で失敗するが、デーモンは生きて他機能は動く）。
- 不正なレジストリエントリ: そのエントリのみ無効化、他は活かす。

## テスト

- `repo-registry`: 解決成功、未登録 → null、不正エントリの無効化、`COCKPIT_REPOS_FILE` 上書き。
- `github-token`: owner 別解決、欠如・空・複数行で throw、`COCKPIT_TOKENS_DIR` 上書き。
- ensureWorktree: `baseBranch` が `origin/<baseBranch>` として反映されること（既存テスト拡張）。
- HerdrExecutor: `githubToken` が startAgent に渡ること（fake で検証）。
- すべてプレースホルダ（`acme/widget` 等）。実 org 名は使わない。

## デプロイ・移行

1. `~/.config/cockpit/tokens/` を作成し、既存 `runner-token` を `tokens/yonda` へ移動
   （`bin/service` の runner-token-sync も owner 別に対応）。
2. 仕事用 org の fine-grained PAT（登録リポジトリ限定）を作り `tokens/<owner>` に配置。
3. `~/.config/cockpit/repos.json` に cockpit と対象リポジトリを登録。
4. `pnpm build:runner` + `bin/service runner-restart`（preflight は owner 別トークンを検証）。

## スコープ外（将来）

- 登録 UI（設定ファイル編集で運用）。
- リポジトリ別の dispatcher settings（network 許可ドメイン・deny ルール）。
- Docker per-job 隔離。
- GitHub App 認証（bot identity）。
- 分解ジョブを herdr に寄せるか SDK 据え置きかの再検討。

## 受け入れ確認

- レジストリに登録した仕事用リポジトリ 1 本で実 Issue を `job.fire` → HerdrExecutor が
  そのリポジトリの worktree で実装 → 正しいベースブランチ起点の feature ブランチに
  draft PR、まで end-to-end で通ること。
- 未登録リポジトリの `job.fire` が fail-closed で失敗すること。
- owner トークン欠如時にそのジョブだけ失敗し、デーモンと他ジョブは生きること。
