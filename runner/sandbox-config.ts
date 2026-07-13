import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

// runner セッションに適用する Seatbelt (sandbox) 設定を生成する純関数モジュール。
// PoC (Issue #36) の実測結論 (docs/sandbox-poc.md「結論: t2 で採用する SandboxSettings」)
// をそのままコードへ落とし込んだもの。
//
// permission-policy.ts と同じ方針で、この時点では sdk-executor に接続しない
// (単独でレビュー・revert 可能にするため。配線は後続 Issue の t2 で行う)。
// buildSandboxSettings() は引数も副作用も持たない純関数で、常に同一の設定を返す。
//
// 各値の根拠は docs/sandbox-poc.md の実験 (E0〜E5) を参照。コメント中の
// 「E1」「E3」等はその実験番号を指す。

/**
 * runner が SDK の `query({ options: { sandbox } })` に渡す SandboxSettings を返す。
 *
 * PoC (Issue #36 / docs/sandbox-poc.md) の実測結論に沿った固定設定。
 * launchd 常駐の runner が非 sandbox に黙って降格しない fail-closed 構成であり、
 * かつ Layer 0 (permission-policy) が全ての副作用系 Bash を捕捉し続けられるよう
 * autoAllowBashIfSandboxed を明示 false にしている。
 */
export function buildSandboxSettings(): SandboxSettings {
  return {
    // sandbox を有効化する大前提。
    enabled: true,

    // E0: 「Seatbelt を適用できない環境では黙って非 sandbox 実行に降格させない」
    // ことを明示するハードゲート。options 経由なら SDK 0.3.205 のデフォルトも true
    // だが、launchd 常駐で無人稼働するため意図を設定として固定する
    // (将来の Linux 移植・依存欠落でデフォルトが変わっても fail-closed を保つ)。
    failIfUnavailable: true,

    // E2: sandbox 化できた Bash を canUseTool 前に auto-allow するか。
    // true にすると canUseTool が完全にバイパスされ、保護ブランチへの force push
    // チェーンまで Layer 0 (permission-policy) の捕捉から外れてしまう。
    // false なら副作用系コマンド (書き込み・push 等) が canUseTool に到達し続け、
    // 現行の許可モデル (Layer 0 が全て見る) を sandbox 下でも維持できる。
    // PoC で push チェーンの canUseTool 到達を実測済み。原則 false。
    autoAllowBashIfSandboxed: false,

    // allowUnsandboxedCommands は既定 (true) のまま明示しない。
    // E2: `dangerouslyDisableSandbox: true` 付きの Bash は設定によらず必ず
    // canUseTool に来るため、policy 側で escalate すれば「人間が cockpit で判断して
    // 通す」脱出ハッチとして機能する。false にするとこのフォールバック経路ごと消える。

    // E3: gh (Go 実装) は sandbox 下で trustd (Mach service) へ到達できず
    // TLS 検証が全滅する (`x509: OSStatus -26276`)。gh だけ sandbox 外で実行させる。
    // excluded な gh は unsandboxed ゆえ auto-allow 対象外となり canUseTool に戻るので、
    // `gh pr merge` 等の危険系は permission-policy が引き続き捕捉できる。
    excludedCommands: ["gh *"],

    network: {
      // E4 (pnpm install 成功) / E3-push (git fetch・push は https で成功)。
      // ここに無いドメインは OS レベルで遮断されるのではなく、疑似ツール
      // `SandboxNetworkAccess {host}` として canUseTool に escalate され、
      // cockpit 側で人間が判断する (default-deny + 人間判断)。
      // - registry.npmjs.org: pnpm install の egress。
      // - github.com / *.github.com: git fetch/push (https)。git は gh と違い
      //   sandbox 下でも成功する。codeload 等のサブドメインも許可するため
      //   ワイルドカードも併記する。
      // fonts 系 (fonts.googleapis.com 等) は allowedDomains に入れても next build が
      //   直らない (next/font/google の fetch がプロキシ非対応) ため入れない。E4 参照。
      allowedDomains: ["registry.npmjs.org", "github.com", "*.github.com"],

      // E4: vitest (runner socket protocol) が Unix ドメインソケットを bind する。
      // これが無いと `EPERM: operation not permitted <tmp>/runner.sock` で
      // server.test.ts が 6 件落ちる。`allowLocalBinding` では直らず、
      // これで全通過する。ソケットパスが mkdtemp のランダム値のため、パス指定の
      // `allowUnixSockets` に絞る余地は follow-up (docs/sandbox-poc.md) とする。
      allowAllUnixSockets: true,
    },

    // filesystem: 追加の allowWrite は不要。E5 でリンク worktree からの
    // commit/branch/add が素で通ることを実測済み (共有 .git への書き込みは
    // セッション起動時に git common dir が検出され許可される)。
    // pnpm の store 共有が欲しくなったら `~/Library/pnpm` を allowWrite に
    // 足す選択肢はあるが、store 汚染と引き換えになるため既定では入れない。

    credentials: {
      // E1: sandbox 下でも読み取り制限はデフォルトでほぼ無い (~/.gitconfig が
      // 読めた)。秘匿ファイルは credentials.files で明示的に deny して守る。
      // ~/.aws は AWS 認証情報 (~/.aws/credentials を含むディレクトリ全体)、
      // ~/.ssh は SSH 秘密鍵。gh のトークンストア (~/.config/gh) と
      // ~/.netrc も併せて塞ぐ。
      files: [
        { path: "~/.ssh", mode: "deny" },
        { path: "~/.aws", mode: "deny" },
        { path: "~/.config/gh", mode: "deny" },
        { path: "~/.netrc", mode: "deny" },
      ],
      // 認証トークンを持つ環境変数はエージェントのプロセスから隠す。
      envVars: [
        { name: "GITHUB_TOKEN", mode: "deny" },
        { name: "ANTHROPIC_API_KEY", mode: "deny" },
      ],
    },
  };
}
