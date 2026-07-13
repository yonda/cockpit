import type { CommandRunner } from "./exec";
import { KeyedMutex } from "./mutex";

/**
 * `git fetch origin main` を repoDir 単位で直列化する共有ヘルパー。
 *
 * 並列 sub-task ディスパッチ時に複数ジョブが同一メインリポジトリへ同時 fetch すると、
 * refs/remotes/origin/main の ref lock を奪い合い、負けた側が failed になる
 * レースコンディションが起きる。runner プロセス内で fetch を repoDir ごとに
 * 1 本ずつ実行することでこれを根本的に防ぐ。
 *
 * 直列化されるのは fetch のみ。fetch 完了後の処理（worktree 作成など）は
 * 呼び出し元で従来どおり並行実行される。
 *
 * さらに保険として、mutex の射程外の競合（複数 runner プロセスの同時起動や
 * 手動 git 操作など）で ref lock に失敗した場合のみ、短い間隔でリトライする。
 * 一時的なロック競合でタスクを failed にしないための防御層であり、
 * ネットワークエラー・認証エラー等の ref lock 以外の失敗はリトライしない。
 */
const fetchMutex = new KeyedMutex();

/** ref lock 失敗時の最大リトライ回数（初回実行を除く） */
const REF_LOCK_MAX_RETRIES = 2;

/** リトライ前の待機時間 (ms) */
const REF_LOCK_RETRY_DELAY_MS = 500;

export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** git の ref lock 失敗（"cannot lock ref" を含むエラー）かどうかを判定する */
function isRefLockError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes("cannot lock ref")) return true;
  // execFile 系のエラーは stderr を別プロパティに持つ場合がある
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" && stderr.includes("cannot lock ref");
}

/**
 * `git fetch origin <branch>` を repoDir 単位で直列化する。per-repo の
 * baseBranch (main とは限らない) に対応するための汎用版。
 */
export async function fetchOrigin(
  commands: CommandRunner,
  repoDir: string,
  branch: string,
  options: { sleep?: SleepFn } = {},
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  await fetchMutex.runExclusive(repoDir, async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await commands.run("git", ["fetch", "origin", branch], {
          cwd: repoDir,
        });
        return;
      } catch (error) {
        if (attempt >= REF_LOCK_MAX_RETRIES || !isRefLockError(error)) {
          throw error;
        }
        await sleep(REF_LOCK_RETRY_DELAY_MS);
      }
    }
  });
}

/** `fetchOrigin(commands, repoDir, "main")` の従来名エイリアス */
export async function fetchOriginMain(
  commands: CommandRunner,
  repoDir: string,
  options: { sleep?: SleepFn } = {},
): Promise<void> {
  return fetchOrigin(commands, repoDir, "main", options);
}
