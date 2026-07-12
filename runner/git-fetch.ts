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
 */
const fetchMutex = new KeyedMutex();

export async function fetchOriginMain(
  commands: CommandRunner,
  repoDir: string,
): Promise<void> {
  await fetchMutex.runExclusive(repoDir, async () => {
    await commands.run("git", ["fetch", "origin", "main"], { cwd: repoDir });
  });
}
