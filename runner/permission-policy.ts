import * as path from "node:path";

// 許可モデル反転の中核となる純関数。
// (toolName, input, ctx) から「自動許可 (allow)」か「人間へ転送 (escalate)」かを判定する。
// SDK には依存せず、この時点では sdk-executor に接続しない (単独でレビュー・revert 可能)。
//
// 設計方針: fail-safe。判定不能・パース不能・許可リスト外はすべて escalate に倒す。
// escalate の reason は cockpit 側の許可プロンプトで人間の判断材料になるため、
// 「何が引っかかったか」を日本語で具体的に書く。

export type PolicyContext = {
  /** ジョブが動いている worktree の絶対パス。破壊的操作の許容範囲。 */
  worktreeDir: string;
};

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "escalate"; reason: string };

const ALLOW: PolicyDecision = { decision: "allow" };

function escalate(reason: string): PolicyDecision {
  return { decision: "escalate", reason };
}

// ---------------------------------------------------------------------------
// 非 Bash ツールの判定
// ---------------------------------------------------------------------------

// 人間の関与が必須、または外部への送信を行うツール。
const ESCALATE_TOOL_REASONS: Record<string, string> = {
  AskUserQuestion: "AskUserQuestion は人間の回答が必要なため転送します",
  WebFetch: "WebFetch は外部ホストへの送信・取得を行うため転送します",
  WebSearch: "WebSearch は外部への送信を行うため転送します",
};

// worktree 内に閉じているかをパスで判定するファイル編集系ツールと、
// その入力のうちパスが入るフィールド名。
const FILE_PATH_TOOLS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

export function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PolicyContext,
): PolicyDecision {
  const reason = ESCALATE_TOOL_REASONS[toolName];
  if (reason) return escalate(reason);

  // MCP ツールは外部サービスへの送信系である可能性を判定できないため fail-safe で転送。
  if (toolName.startsWith("mcp__")) {
    return escalate(`MCP ツール ${toolName} は送信系の可能性があるため転送します`);
  }

  if (toolName === "Bash") {
    return evaluateBashCommand(input, ctx);
  }

  const pathField = FILE_PATH_TOOLS[toolName];
  if (pathField) {
    const target = input[pathField];
    if (typeof target !== "string" || target.length === 0) {
      return escalate(`${toolName} の対象パスを特定できないため転送します`);
    }
    if (pathStatus(target, ctx.worktreeDir) !== "inside") {
      return escalate(
        `${toolName} が worktree (${ctx.worktreeDir}) 外のパスを対象にしています: ${target}`,
      );
    }
    return ALLOW;
  }

  // Read/Glob/Grep/TodoWrite/Task 等、副作用が worktree 実行環境に閉じるツールは許可。
  return ALLOW;
}

// ---------------------------------------------------------------------------
// パス判定
// ---------------------------------------------------------------------------

type PathStatus = "inside" | "outside" | "unknown";

// token が worktree 内を指すか。相対パスは cwd = worktreeDir 前提で解決する。
// 変数展開を含むなど静的に解決できないものは "unknown" (呼び出し側で escalate)。
function pathStatus(token: string, worktreeDir: string): PathStatus {
  if (token.includes("$")) return "unknown";
  if (token === "~" || token.startsWith("~/")) return "outside";
  const resolved = path.resolve(worktreeDir, token);
  const rel = path.relative(worktreeDir, resolved);
  if (rel === "") return "inside"; // worktree ルートそのもの
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "outside";
  return "inside";
}

// ---------------------------------------------------------------------------
// Bash コマンドのパース
// ---------------------------------------------------------------------------

type ParsedSegment = {
  /** 引数トークン列 (クォート除去済み) */
  tokens: string[];
  /** 出力リダイレクト先 (>, >>)。fd 複製 (2>&1 等) は含まない */
  redirectTargets: string[];
};

// コマンド文字列を「&& / || / ; / | / & / 改行」で区切ったセグメント列に分解する。
// 解析できない構文 (コマンド置換 $()・バッククォート・プロセス置換・サブシェル・
// ブレース展開・閉じていないクォート) を含む場合は null を返し、呼び出し側が
// fail-safe に escalate する。
function parseCommand(command: string): ParsedSegment[] | null {
  const segments: ParsedSegment[] = [];
  let tokens: string[] = [];
  let redirectTargets: string[] = [];
  let current = "";
  let hasCurrent = false;
  let expectRedirectTarget = false;
  let i = 0;

  const pushToken = () => {
    if (!hasCurrent) return;
    if (expectRedirectTarget) {
      // "&1" のような fd 複製はファイル書き込みではないので記録しない
      if (!current.startsWith("&")) redirectTargets.push(current);
      expectRedirectTarget = false;
    } else {
      tokens.push(current);
    }
    current = "";
    hasCurrent = false;
  };

  const pushSegment = () => {
    pushToken();
    if (tokens.length > 0 || redirectTargets.length > 0) {
      segments.push({ tokens, redirectTargets });
      tokens = [];
      redirectTargets = [];
    }
  };

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null; // 閉じていないシングルクォート
      current += command.slice(i + 1, end);
      hasCurrent = true;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let buf = "";
      let closed = false;
      while (j < command.length) {
        const c = command[j];
        if (c === "\\") {
          buf += command[j + 1] ?? "";
          j += 2;
          continue;
        }
        // ダブルクォート内でもコマンド置換は実行されるため解析不能扱い
        if (c === "`") return null;
        if (c === "$" && command[j + 1] === "(") return null;
        if (c === '"') {
          closed = true;
          j++;
          break;
        }
        buf += c;
        j++;
      }
      if (!closed) return null;
      current += buf;
      hasCurrent = true;
      i = j;
      continue;
    }

    if (ch === "\\") {
      current += command[i + 1] ?? "";
      hasCurrent = true;
      i += 2;
      continue;
    }

    // 実行内容が静的に追えない構文はすべて解析不能扱い
    if (ch === "`") return null;
    if (ch === "$" && command[i + 1] === "(") return null;
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") return null;
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") return null;

    if (ch === "&" && expectRedirectTarget && !hasCurrent) {
      // 2>&1 の "&1" 部分。セパレータではなくリダイレクト先トークンの一部。
      current += ch;
      hasCurrent = true;
      i++;
      continue;
    }

    if (ch === ";" || ch === "\n" || ch === "&" || ch === "|") {
      pushSegment();
      i++;
      if ((ch === "&" || ch === "|") && command[i] === ch) i++; // && / ||
      continue;
    }

    if (ch === ">") {
      // "2>" のような fd プレフィックスはトークンとして残さない
      if (hasCurrent && /^\d+$/.test(current)) {
        current = "";
        hasCurrent = false;
      }
      pushToken();
      expectRedirectTarget = true;
      i++;
      if (command[i] === ">") i++; // >>
      continue;
    }

    if (ch === "<") {
      // 入力リダイレクト: 読み込みのみなので対象ファイルは通常トークンとして扱う
      if (hasCurrent && /^\d+$/.test(current)) {
        current = "";
        hasCurrent = false;
      }
      pushToken();
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      pushToken();
      i++;
      continue;
    }

    current += ch;
    hasCurrent = true;
    i++;
  }

  pushSegment();
  if (expectRedirectTarget) return null; // 末尾が "cmd >" で終わっている
  if (segments.length === 0) return null;
  return segments;
}

// ---------------------------------------------------------------------------
// Bash セグメントごとの判定
// ---------------------------------------------------------------------------

// 読み取り中心で副作用が小さい、または worktree 実行に必要なコマンド。
// node / pnpm は sdk-executor の allowedTools (Bash(pnpm:*)) と同じ判断で丸ごと許可
// (実装ジョブは隔離 worktree 内で動くため、リスクを worktree に収める)。
const SAFE_SIMPLE_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "echo",
  "printf",
  "pwd",
  "which",
  "true",
  "false",
  "test",
  "date",
  "jq",
  "node",
  "pnpm",
]);

// 引数のパスに書き込む・削除するコマンド。全パス引数が worktree 内であることを要求。
const WRITE_PATH_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "shred",
]);

// main / develop (と慣習的に同格の master) への push は draft PR フローを迂回するため転送。
const PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);

function evaluateBashCommand(
  input: Record<string, unknown>,
  ctx: PolicyContext,
): PolicyDecision {
  const command = input.command;
  if (typeof command !== "string" || command.trim() === "") {
    return escalate("Bash の command を特定できないため転送します");
  }

  const segments = parseCommand(command);
  if (segments === null) {
    return escalate(
      `コマンドを静的に解析できないため転送します (サブシェル・コマンド置換・クォート不整合等): ${command}`,
    );
  }

  // コマンド連結 (&& / ; / |) は各セグメントを個別に判定し、1つでも危険なら転送する
  for (const segment of segments) {
    const result = evaluateSegment(segment, ctx);
    if (result.decision === "escalate") return result;
  }
  return ALLOW;
}

function evaluateSegment(
  segment: ParsedSegment,
  ctx: PolicyContext,
): PolicyDecision {
  // 出力リダイレクト先は worktree 内 (または /dev/null) に限る
  for (const target of segment.redirectTargets) {
    if (target === "/dev/null") continue;
    if (pathStatus(target, ctx.worktreeDir) !== "inside") {
      return escalate(
        `worktree 外へのリダイレクト書き込みのため転送します: > ${target}`,
      );
    }
  }

  let tokens = [...segment.tokens];

  // 先頭の環境変数代入 (FOO=bar cmd ...) を剥がす
  const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
  while (tokens.length > 0 && ASSIGN_RE.test(tokens[0])) tokens = tokens.slice(1);
  if (tokens.length > 0 && tokens[0] === "env") {
    tokens = tokens.slice(1);
    while (tokens.length > 0 && ASSIGN_RE.test(tokens[0])) {
      tokens = tokens.slice(1);
    }
  }
  if (tokens.length === 0) return ALLOW; // 変数代入のみ

  const cmd = tokens[0];

  // パス指定での実行 (./script.sh, /usr/bin/x) は中身を追えないため転送
  if (cmd.includes("/")) {
    return escalate(`パス指定の実行ファイルは内容を判定できないため転送します: ${cmd}`);
  }
  if (cmd.includes("$")) {
    return escalate(`コマンド名に変数展開を含むため転送します: ${cmd}`);
  }

  if (cmd === "git") return evaluateGit(tokens);
  if (cmd === "gh") return evaluateGh(tokens);
  if (cmd === "curl" || cmd === "wget") return evaluateCurlWget(tokens);
  if (WRITE_PATH_COMMANDS.has(cmd)) return evaluateWritePathCommand(tokens, ctx);

  if (cmd === "sed") {
    const inPlace = tokens.some(
      (t) => t === "-i" || t.startsWith("-i") || t === "--in-place",
    );
    if (inPlace) {
      return escalate("sed -i (in-place 書き換え) は対象を判定できないため転送します");
    }
    return ALLOW;
  }

  if (cmd === "find") {
    const dangerous = tokens.find((t) =>
      ["-exec", "-execdir", "-ok", "-okdir", "-delete"].includes(t),
    );
    if (dangerous) {
      return escalate(`find の ${dangerous} は任意コマンド実行・削除のため転送します`);
    }
    return ALLOW;
  }

  if (SAFE_SIMPLE_COMMANDS.has(cmd)) return ALLOW;

  // 許可リスト外 (sh -c / bash / xargs / eval / sudo / npx 等を含む) は fail-safe で転送
  return escalate(`許可リストにないコマンドのため転送します: ${cmd}`);
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function evaluateGit(tokens: string[]): PolicyDecision {
  // サブコマンドより前のグローバルオプションを走査
  let i = 1;
  let subcommand: string | null = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-C" || t.startsWith("--git-dir") || t.startsWith("--work-tree")) {
      // 別リポジトリ (worktree 外) を対象にできるため転送
      return escalate(`git の ${t} は worktree 外のリポジトリを操作できるため転送します`);
    }
    if (t === "-c") {
      i += 2; // -c key=value
      continue;
    }
    if (t.startsWith("-")) {
      i++;
      continue;
    }
    subcommand = t;
    break;
  }
  if (subcommand === null) {
    return escalate("git のサブコマンドを特定できないため転送します");
  }

  if (subcommand === "push") return evaluateGitPush(tokens.slice(i + 1));

  // push 以外の git はローカル操作 (add/commit/status/diff/log/checkout 等) として許可。
  // sdk-executor の Bash(git:*) と同じ割り切り。
  return ALLOW;
}

function evaluateGitPush(args: string[]): PolicyDecision {
  const positionals: string[] = [];
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (
      t === "-f" ||
      t === "--force" ||
      t === "--force-with-lease" ||
      t.startsWith("--force-with-lease=") ||
      t === "--force-if-includes"
    ) {
      return escalate(`git push の force オプション (${t}) のため転送します`);
    }
    if (t === "-d" || t === "--delete") {
      return escalate("git push --delete (リモートブランチ削除) のため転送します");
    }
    if (t === "--mirror" || t === "--all" || t === "--tags" || t === "--prune") {
      return escalate(`git push ${t} は push 先を特定できないため転送します`);
    }
    if (t === "-o" || t === "--push-option" || t === "--repo") {
      i += 2; // 値を取るオプション
      if (t === "--repo") {
        return escalate("git push --repo は push 先を特定できないため転送します");
      }
      continue;
    }
    if (/^-[A-Za-z]+$/.test(t)) {
      // 短縮フラグの束 (-fu 等) に f / d が含まれる場合も force / delete とみなす
      if (t.includes("f")) {
        return escalate(`git push の force オプション (${t}) のため転送します`);
      }
      if (t.includes("d")) {
        return escalate("git push --delete (リモートブランチ削除) のため転送します");
      }
      i++;
      continue;
    }
    if (t.startsWith("-")) {
      i++;
      continue;
    }
    positionals.push(t);
    i++;
  }

  // positionals = [remote, ...refspecs]
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    return escalate(
      "git push の push 先ブランチを特定できないため転送します (refspec を明示してください)",
    );
  }

  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) {
      return escalate(`refspec の + prefix は force push のため転送します: ${refspec}`);
    }
    const colon = refspec.indexOf(":");
    if (colon === 0) {
      // ":branch" は空の src、つまりリモートブランチ削除
      return escalate(
        `refspec の空 src はリモートブランチ削除のため転送します: ${refspec}`,
      );
    }
    const dstRaw = colon === -1 ? refspec : refspec.slice(colon + 1);
    if (dstRaw === "") {
      return escalate(`空の push 先 refspec はリモートブランチ削除のため転送します: ${refspec}`);
    }
    if (dstRaw.includes("$")) {
      return escalate(`push 先に変数展開を含むため転送します: ${refspec}`);
    }
    const dst = dstRaw.replace(/^refs\/heads\//, "");
    if (PROTECTED_BRANCHES.has(dst)) {
      return escalate(`保護ブランチ (${dst}) への push のため転送します`);
    }
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

// gh は allow リスト方式。ここに無い操作 (pr merge / pr ready / repo delete 等) は
// すべて転送される。
function evaluateGh(tokens: string[]): PolicyDecision {
  const sub = tokens[1] ?? "";
  const action = tokens[2] ?? "";

  // 明示的な危険操作は専用の理由を付ける (fail-safe の網にも掛かるが判断材料を厚くする)
  if (sub === "pr" && action === "merge") {
    return escalate("gh pr merge (マージ) は人間の判断が必要なため転送します");
  }
  if (sub === "pr" && action === "ready") {
    return escalate("gh pr ready (draft 解除) は人間の判断が必要なため転送します");
  }

  // gh api は Issue コメント等のワークフロー操作に必要なため許可する割り切り
  // (worktree 運用の draft PR フローでレビューされる前提)。
  if (sub === "api") return ALLOW;

  if (sub === "issue" && ["view", "list", "status"].includes(action)) return ALLOW;
  if (sub === "pr" && ["view", "list", "diff", "checks", "status"].includes(action)) {
    return ALLOW;
  }
  if (sub === "pr" && action === "create") {
    if (tokens.includes("--draft")) return ALLOW;
    return escalate("gh pr create は --draft 付きのみ許可のため転送します");
  }

  return escalate(`許可リストにない gh 操作のため転送します: gh ${sub} ${action}`.trim());
}

// ---------------------------------------------------------------------------
// curl / wget
// ---------------------------------------------------------------------------

// 値を取るフラグ (次のトークンを URL 候補から除外する)
const CURL_WGET_VALUE_FLAGS = new Set([
  // curl
  "-H",
  "--header",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "-F",
  "--form",
  "-o",
  "--output",
  "-u",
  "--user",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-b",
  "--cookie",
  "-c",
  "--cookie-jar",
  "-T",
  "--upload-file",
  "-X",
  "--request",
  "-w",
  "--write-out",
  "--connect-timeout",
  "--max-time",
  "--retry",
  // wget
  "-O",
  "--output-document",
  "-P",
  "--directory-prefix",
  "-U",
  "--tries",
  "--timeout",
]);

const LOCAL_URL_RE =
  /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)(:\d+)?([/?#].*)?$/i;
const SCHEME_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?(\/.*)?$/i;

function evaluateCurlWget(tokens: string[]): PolicyDecision {
  const cmd = tokens[0];
  let localCount = 0;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (CURL_WGET_VALUE_FLAGS.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i++;
      continue;
    }
    // 位置引数 = URL 候補
    if (t.includes("$")) {
      return escalate(`${cmd} の宛先に変数展開を含むため転送します: ${t}`);
    }
    if (LOCAL_URL_RE.test(t)) {
      localCount++;
      i++;
      continue;
    }
    if (SCHEME_URL_RE.test(t) || BARE_DOMAIN_RE.test(t)) {
      return escalate(`${cmd} による外部ホストへの送信のため転送します: ${t}`);
    }
    // URL に見えない位置引数は宛先不明として fail-safe に転送
    return escalate(`${cmd} の宛先を特定できないため転送します: ${t}`);
  }
  if (localCount === 0) {
    return escalate(`${cmd} の宛先を特定できないため転送します`);
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// rm / mv / cp 等のパス書き込み系
// ---------------------------------------------------------------------------

function evaluateWritePathCommand(
  tokens: string[],
  ctx: PolicyContext,
): PolicyDecision {
  const cmd = tokens[0];
  const pathArgs = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (pathArgs.length === 0) {
    return escalate(`${cmd} の対象パスを特定できないため転送します`);
  }
  for (const arg of pathArgs) {
    const status = pathStatus(arg, ctx.worktreeDir);
    if (status === "outside") {
      return escalate(
        `${cmd} が worktree (${ctx.worktreeDir}) 外のパスを対象にしているため転送します: ${arg}`,
      );
    }
    if (status === "unknown") {
      return escalate(`${cmd} の対象パスを静的に解決できないため転送します: ${arg}`);
    }
  }
  return ALLOW;
}
