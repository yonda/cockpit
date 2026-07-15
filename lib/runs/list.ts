import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseProgress } from "./progress";
import type { ProgressFile } from "./progress";

/**
 * issue-driver skill が書く進捗ファイルを、全リポジトリ横断で一覧・パースする list 層。
 * cockpit のレンズが「どの issue が今どう分解され動いているか」を表示するための入口。
 *
 * `~/.cache/cockpit/runs/<repo-slug>/<issueNumber>.json` を列挙する。
 * 壊れた/読めないファイルは全体を落とさずスキップする(fail-safe)。
 */

export const RUNS_DIR = join(homedir(), ".cache", "cockpit", "runs");

export type ListProgressResult = {
  files: ProgressFile[];
  /** パースに失敗した/読めなかったファイルのパスとエラーメッセージ */
  skipped: { path: string; error: string }[];
};

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * `~/.cache/cockpit/runs/` 配下の全 run ファイルを一覧・パースする。
 * ディレクトリが無ければ(まだ1件も run が無い状態) 空の結果を返す。
 */
export function listProgressFiles(runsDir: string = RUNS_DIR): ListProgressResult {
  const files: ProgressFile[] = [];
  const skipped: { path: string; error: string }[] = [];

  for (const repoSlug of safeReaddir(runsDir)) {
    const repoDir = join(runsDir, repoSlug);
    for (const entry of safeReaddir(repoDir)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(repoDir, entry);
      try {
        const json = readFileSync(path, "utf-8");
        files.push(parseProgress(json));
      } catch (e) {
        skipped.push({ path, error: (e as Error).message });
      }
    }
  }

  return { files, skipped };
}
