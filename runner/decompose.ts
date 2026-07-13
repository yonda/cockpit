import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentExecutor } from "./executor";
import type { CommandRunner } from "./exec";
import { fetchOriginMain } from "./git-fetch";
import { isSubTaskArray, type SubTask } from "../lib/pbi/types";

export const DECOMPOSITION_FILE = "decomposition.json";

export type PreparedCwd = { cwd: string; cleanup: () => Promise<void> };

export type DecomposeDeps = {
  executor: AgentExecutor;
  /** 分解を走らせる cwd を用意する。実運用は読み取り worktree を作り、cleanup で破棄する。
      テストは temp dir を返すフェイクを注入する（DI: マジックパス判定はしない）。 */
  prepareCwd: (issueNumber: number) => Promise<PreparedCwd>;
};

export function buildDecomposePrompt(args: {
  issueNumber: number;
  title: string;
  body: string;
  priorTasks?: SubTask[];
  feedback?: string;
}): string {
  const lines = [
    `PBI Issue #${args.issueNumber}: ${args.title} をタスクに分解してください。`,
    "",
    "## PBI 本文",
    args.body,
    "",
    "## 分解の原則",
    "- 1 タスク = 1 PR = 1 revert 単位（独立してレビュー・巻き戻しできる粒度）",
    "- 各タスクに key（t1, t2, ...）, title, goal, deliverable, acceptanceCriteria[], dependsOn[] を与える",
    "- dependsOn は他タスクの key を参照する。循環させない",
    "- コードベースを読み、既存パターンに沿った現実的な切り方にする",
    "",
    `## 出力`,
    `- 分解結果を SubTask[] の JSON として ./${DECOMPOSITION_FILE} に書き出すこと`,
    "- JSON 以外のファイルは変更しないこと（このディレクトリは読み取り解析用）",
  ];
  if (args.priorTasks && args.feedback) {
    lines.push(
      "",
      "## 前回の分解案（見直し依頼）",
      "```json",
      JSON.stringify(args.priorTasks, null, 2),
      "```",
      "## 修正指示",
      args.feedback,
    );
  }
  return lines.join("\n");
}

export async function runDecomposition(
  deps: DecomposeDeps,
  args: {
    repo: string;
    issueNumber: number;
    title: string;
    body: string;
    priorTasks?: SubTask[];
    feedback?: string;
    signal: AbortSignal;
  },
): Promise<{ ok: true; tasks: SubTask[] } | { ok: false; error: string }> {
  const { cwd, cleanup } = await deps.prepareCwd(args.issueNumber);
  try {
    const result = await deps.executor.run(
      {
        cwd,
        prompt: buildDecomposePrompt(args),
        resumeSessionId: null,
        // TODO(Task 6+): 分解ジョブの対象リポジトリ owner トークンに差し替える
        githubToken: null,
        signal: args.signal,
      },
      {
        onSessionId: () => {},
        onActivity: () => {},
        requestInput: async () => ({ kind: "allow" }),
      },
    );
    if (!result.ok) return { ok: false, error: result.error };

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(cwd, DECOMPOSITION_FILE), "utf8"));
    } catch {
      return {
        ok: false,
        error: `${DECOMPOSITION_FILE} が見つからないか壊れています`,
      };
    }
    if (!isSubTaskArray(parsed)) {
      return { ok: false, error: "分解結果がスキーマに一致しません" };
    }
    if (parsed.length === 0) {
      return {
        ok: false,
        error: "分解結果が空です（少なくとも1つのタスクが必要）",
      };
    }
    return { ok: true, tasks: parsed };
  } finally {
    await cleanup();
  }
}

/** 実運用の prepareCwd: origin/main から読み取り worktree を作り、cleanup で破棄する。
    分解は読み取り専用の解析なのでブランチは作らない（detached HEAD）。
    ブランチを作ると pbi.revise / 再 pbi.fire のたびに同名ブランチが残留して衝突する。 */
export function realPrepareCwd(commands: CommandRunner, repoDir: string) {
  return async (issueNumber: number): Promise<PreparedCwd> => {
    const wtRoot = join(dirname(repoDir), `${basename(repoDir)}-wt`);
    const cwd = join(wtRoot, `decomp/${issueNumber}`);
    // 同一 repoDir への並行 fetch は ref lock を奪い合うため、共有ヘルパーで直列化する
    await fetchOriginMain(commands, repoDir);
    // 前回クラッシュ等で残った worktree を掃除してから作り直す
    try {
      await commands.run("git", ["worktree", "remove", "--force", cwd], {
        cwd: repoDir,
      });
    } catch {
      // 無ければ無視
    }
    try {
      await commands.run("git", ["worktree", "prune"], { cwd: repoDir });
    } catch {
      // best-effort
    }
    // detached HEAD で作る（ブランチを作らない＝再実行でも衝突しない、リークもない）
    await commands.run("git", ["worktree", "add", "--detach", cwd, "origin/main"], {
      cwd: repoDir,
    });
    await commands.run("pnpm", ["install"], { cwd });
    return {
      cwd,
      cleanup: async () => {
        try {
          await commands.run("git", ["worktree", "remove", "--force", cwd], {
            cwd: repoDir,
          });
        } catch {
          // 破棄失敗は致命でない
        }
      },
    };
  };
}
