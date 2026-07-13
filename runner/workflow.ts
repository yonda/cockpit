import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { PendingInput } from "../lib/jobs/types";
import { NO_CHANGES_MARKER } from "../lib/pbi/types";
import type { AgentExecutor, CommandRunner } from "./executor";
import { fetchOriginMain } from "./git-fetch";
import type { InputBroker } from "./input-broker";
import type { JobStore } from "./store";

export type WorkflowDeps = {
  store: JobStore;
  broker: InputBroker;
  commands: CommandRunner;
  executor: AgentExecutor;
  /** メインリポジトリの絶対パス (worktree 作成の起点) */
  repoDir: string;
};

export function buildBranchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return `feature/${issueNumber}-${slug || "issue"}`;
}

function buildPrompt(args: {
  issueNumber: number;
  title: string;
  body: string;
  branch: string;
}): string {
  return [
    `Issue #${args.issueNumber}: ${args.title} を実装してください。`,
    "",
    "## Issue 本文",
    args.body,
    "",
    "## 進め方",
    `- このディレクトリは Issue 専用の git worktree です (ブランチ: ${args.branch})`,
    "- 実装が終わったらテスト・lint を通し、変更をコミットして origin に push してください",
    `- 最後に \`gh pr create --draft\` で draft PR を作成してください`,
    `- コミットメッセージにも PR 本文にも closing keyword (\`close\`/\`fixes\`/\`resolves\` などに続けて番号) を書かないこと。Issue のクローズはマージ後に人間または上位のマージ検知が行います (push だけで Issue が早期クローズすると、上位のマージ検知が壊れるため)。関連付けが必要なら PR 本文に "refs #${args.issueNumber}" と書いてください`,
    "- セルフレビュー用のスキル (/code-review 等) は実行しないでください。実装 → テスト/lint → コミット → push → draft PR に集中してください (レビューは別レイヤーの責務です)",
    `- ただし検証の結果、コード変更が不要だと結論した場合は PR を作らないでください。代わりに、なぜ変更が不要と判断したのか（確認した箇所・根拠）を検証エビデンスとしてまとめ、担当 Issue #${args.issueNumber} に \`gh issue comment ${args.issueNumber}\` でコメント投稿してください。そのコメント本文には必ずマーカー文字列 \`${NO_CHANGES_MARKER}\` をそのまま含めること (runner がこのマーカーの有無で「差分なし完了」を機械的に検証します)。このコメントを投稿したら PR を作らずに終了してください`,
    "- 完了条件は「draft PR の作成」または「上記の no-changes マーカー付きコメントの投稿」のどちらかです",
  ].join("\n");
}

function buildReviewReplyPrompt(args: {
  issueNumber: number;
  title: string;
  branch: string;
}): string {
  return [
    `sub-task「${args.title}」(Issue #${args.issueNumber}) の draft PR にレビューコメントが付きました。`,
    "",
    "## 進め方",
    `- このディレクトリは既存の git worktree です (ブランチ: ${args.branch})`,
    "- `gh pr view --json reviewThreads` 等で未解決のレビュースレッドを確認してください",
    "- 指摘に対応し、テスト・lint を通し、コミットして origin に push してください",
    "- 各スレッドに対応内容を返信してください (gh api のレビューコメント返信)",
    "- コミットメッセージにも PR 本文にも closing keyword (`close`/`fixes`/`resolves` などに続けて番号) を書かないこと",
    "- セルフレビュー用のスキル (/code-review 等) は実行しないでください",
    "- 対応と返信まで終えたら終了してください",
  ].join("\n");
}

/**
 * 担当 Issue のコメントを gh api で取得し、NO_CHANGES_MARKER を含むものが
 * あるか外部検証する。エージェントの自己申告ではなく、投稿済みコメントという
 * 検証可能なアーティファクトを確認する。取得に失敗した場合は「マーカーなし」
 * 扱い (= 従来どおり failed) にフォールバックする。
 */
async function checkNoChangesMarker(
  deps: WorkflowDeps,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  try {
    const { stdout } = await deps.commands.run(
      "gh",
      ["api", `/repos/${repo}/issues/${issueNumber}/comments`],
      { cwd: deps.repoDir },
    );
    const comments = JSON.parse(stdout) as Array<{ body?: string }>;
    return comments.some((c) => (c.body ?? "").includes(NO_CHANGES_MARKER));
  } catch {
    return false;
  }
}

/** git worktree list --porcelain の出力から branch -> path を引く */
function findWorktreePath(porcelain: string, branch: string): string | null {
  let currentPath: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && currentPath) return currentPath;
  }
  return null;
}

async function ensureWorktree(
  deps: WorkflowDeps,
  branch: string,
): Promise<string> {
  const list = async () => {
    const { stdout } = await deps.commands.run(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: deps.repoDir },
    );
    return findWorktreePath(stdout, branch);
  };

  // sub-task ブランチは origin/main を起点に作るため upstream が origin/main になる。
  // ユーザーのグローバル push.default=tracking のままだと、エージェントの `git push` が
  // feature ブランチではなく origin/main に飛び、draft PR ゲートを素通りして main を汚す
  // (dogfood 2026-07-11 で実際に発生)。repo-local で push.default=current にすると、
  // 各ブランチは同名リモートブランチに push される (main→main / feature/X→feature/X)。
  // 明示 refspec (`git push origin HEAD:main`) には影響しない。idempotent。
  await deps.commands.run("git", ["config", "push.default", "current"], {
    cwd: deps.repoDir,
  });

  const existing = await list();
  if (existing) return existing; // 再発射・リトライは既存 worktree を再利用

  // plain `git worktree add` で作る。`git wt` はユーザーのグローバル wt.hook
  // (`npm ci`) を継承し、pnpm リポジトリでは lockfile 不一致で失敗する。runner は
  // デーモンなので対話用フックに依存せず自己完結させる。配置は git-wt と同じ
  // ../{repo}-wt/{branch}。起点は origin/main を明示 (ローカル main は worktree
  // 運用では更新されない前提なので、直前の `git fetch origin main` を活かす)。
  const wtRoot = join(dirname(deps.repoDir), `${basename(deps.repoDir)}-wt`);
  const worktreePath = join(wtRoot, branch);

  const branchExists = await deps.commands
    .run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: deps.repoDir,
    })
    .then(() => true)
    .catch(() => false);

  const addArgs = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", worktreePath, "-b", branch, "origin/main"];
  await deps.commands.run("git", addArgs, { cwd: deps.repoDir });

  // node_modules は worktree にコピーされないので依存を入れる (git-wt の hook
  // が担っていた役割を明示的に肩代わり)。
  await deps.commands.run("pnpm", ["install"], { cwd: worktreePath });

  const created = await list();
  if (!created) {
    throw new Error(`worktree not found after creating ${branch}`);
  }
  return created;
}

export async function runIssueJob(
  deps: WorkflowDeps,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  const job = deps.store.get(jobId);
  if (!job) throw new Error(`unknown job: ${jobId}`);
  const isResume = job.sessionId !== null && job.worktreePath !== null;
  if (job.status === "waiting_input") {
    deps.store.transition(jobId, "running", { pendingInput: null });
  } else if (job.status !== "running") {
    deps.store.transition(jobId, "running");
  }

  try {
    // 1. worktree 準備
    let worktreePath = job.worktreePath;
    if (!isResume) {
      // 同一 repoDir への並行 fetch は ref lock を奪い合うため、共有ヘルパーで直列化する
      await fetchOriginMain(deps.commands, deps.repoDir);
      worktreePath = await ensureWorktree(deps, job.branch);
      deps.store.update(jobId, { worktreePath });
    }

    // 2. プロンプト組み立て
    let prompt: string;
    if (isResume) {
      prompt =
        "runner プロセスの再起動から復帰しました。直前の作業状態 (git status とここまでの会話) を確認し、Issue の実装を続行してください。" +
        `完了条件は「draft PR の作成」または「コード変更が不要と結論した場合に担当 Issue #${job.issueNumber} へマーカー文字列 ${NO_CHANGES_MARKER} を含む検証エビデンスコメントを投稿すること」のどちらかです (差分なし完了は gh issue comment ${job.issueNumber} で投稿し、PR は作りません)。` +
        "なお、コミットメッセージにも PR 本文にも closing keyword (close/fixes/resolves などに続けて番号) を書かないでください。Issue のクローズはマージ後に人間または上位のマージ検知が行います。関連付けが必要なら PR 本文に refs で参照してください。";
    } else if (job.kind === "review_reply") {
      const { stdout } = await deps.commands.run(
        "gh",
        ["issue", "view", String(job.issueNumber), "--json", "title"],
        { cwd: deps.repoDir },
      );
      const issue = JSON.parse(stdout) as { title: string };
      prompt = buildReviewReplyPrompt({
        issueNumber: job.issueNumber,
        title: issue.title,
        branch: job.branch,
      });
    } else {
      const { stdout } = await deps.commands.run(
        "gh",
        ["issue", "view", String(job.issueNumber), "--json", "title,body"],
        { cwd: deps.repoDir },
      );
      const issue = JSON.parse(stdout) as { title: string; body: string };
      prompt = buildPrompt({
        issueNumber: job.issueNumber,
        title: issue.title,
        body: issue.body ?? "",
        branch: job.branch,
      });
    }

    // 3. エージェント実行
    const result = await deps.executor.run(
      {
        cwd: worktreePath!,
        prompt,
        resumeSessionId: isResume ? job.sessionId : null,
        signal,
      },
      {
        onSessionId: (sessionId) => deps.store.update(jobId, { sessionId }),
        onActivity: (text) => deps.store.update(jobId, { lastActivity: text }),
        requestInput: async (raw) => {
          const input: PendingInput = {
            ...raw,
            id: raw.id || `in-${randomUUID().slice(0, 8)}`,
            createdAt: new Date().toISOString(),
          };
          deps.store.transition(jobId, "waiting_input", {
            pendingInput: input,
          });
          const response = await deps.broker.request(jobId, input);
          // キャンセル済みなら running に戻さない
          if (deps.store.get(jobId)?.status === "waiting_input") {
            deps.store.transition(jobId, "running", { pendingInput: null });
          }
          return response;
        },
      },
    );

    if (signal.aborted) return; // cancel 側が状態遷移を行う

    if (!result.ok) {
      // executor が requestInput を投げっぱなしのまま終了した場合に備え、
      // broker に残った entry を掃除してから失敗遷移する (漏れ防止)
      deps.broker.abort(jobId);
      deps.store.transition(jobId, "failed", {
        error: result.error,
        pendingInput: null,
      });
      return;
    }

    // 4. 成果検証: エージェントの自己申告を信用せず PR を確認する
    const { stdout } = await deps.commands.run(
      "gh",
      [
        "pr",
        "list",
        "--head",
        job.branch,
        "--state",
        "open",
        "--json",
        "url",
      ],
      { cwd: deps.repoDir },
    );
    const prs = JSON.parse(stdout) as Array<{ url: string }>;
    if (prs.length === 0) {
      // PR が無くても即失敗にしない。エージェントが「差分なし完了」を宣言した
      // 可能性があるので、担当 Issue のコメントを gh api で外部検証し、
      // NO_CHANGES_MARKER 付きのエビデンスがあれば done (PR なし完了) にする。
      // 自己申告ではなく、投稿済みコメントという検証可能なアーティファクトを見る。
      const hasNoChangesMarker = await checkNoChangesMarker(
        deps,
        job.repo,
        job.issueNumber,
      );
      if (hasNoChangesMarker) {
        deps.store.transition(jobId, "done", { prUrl: null, noChanges: true });
        return;
      }
      deps.store.transition(jobId, "failed", {
        error: "エージェント終了後に draft PR が見つかりませんでした",
      });
      return;
    }
    deps.store.transition(jobId, "done", { prUrl: prs[0].url });
  } catch (err) {
    if (signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    const current = deps.store.get(jobId);
    if (current && ["running", "waiting_input"].includes(current.status)) {
      // ここでも同様に broker の残留 entry を掃除してから失敗遷移する
      deps.broker.abort(jobId);
      deps.store.transition(jobId, "failed", { error: message, pendingInput: null });
    }
  }
}
