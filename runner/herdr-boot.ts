import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentExecutor } from "./executor";
import { HerdrExecutor } from "./herdr-executor";
import { RealHerdrClient, RealTranscriptReader } from "./herdr-real";

// 垂直スライス (#58) の配線: 既定は SdkExecutor のまま、env でオプトインしたときだけ
// HerdrExecutor を使う。常駐デーモンの実行系を初回スライスで丸ごと差し替えないための
// 安全弁 (dogfood は 1 ジョブを HerdrExecutor で流して比較する)。
//
//   COCKPIT_EXECUTOR=herdr           … HerdrExecutor を有効化
//   COCKPIT_HERDR_WORKSPACE=<wsId>   … タブを作る herdr ワークスペース ID (必須)
//
// settings は repo 同梱の runner/herdr-runner-settings.json を REPO_DIR 基準で解決する。

export function buildHerdrExecutorFromEnv(repoDir: string): AgentExecutor | null {
  if (process.env.COCKPIT_EXECUTOR !== "herdr") return null;
  const workspaceId = process.env.COCKPIT_HERDR_WORKSPACE;
  if (!workspaceId) {
    throw new Error(
      "COCKPIT_EXECUTOR=herdr には COCKPIT_HERDR_WORKSPACE (herdr ワークスペース ID) が必要です",
    );
  }
  const settingsPath = path.join(repoDir, "runner", "herdr-runner-settings.json");
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`dispatcher settings が見つかりません: ${settingsPath}`);
  }
  return new HerdrExecutor({
    herdr: new RealHerdrClient(),
    transcript: new RealTranscriptReader(),
    trustWorktree,
    settingsPath,
    workspaceId,
  });
}

// worktree を ~/.claude.json で明示 trust する (hasTrustDialogAccepted)。
// これが無いと CLI が worktree 側 settings の allow を untrusted として無視する
// (PoC E2)。deny/sandbox は trust の有無に関わらず効くが、正常系の allow を通すため
// dispatcher が spawn 前に付与する。
export async function trustWorktree(
  cwd: string,
  claudeJsonPath: string = path.join(os.homedir(), ".claude.json"),
): Promise<void> {
  const file = claudeJsonPath;
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    // 未作成なら空から作る
  }
  const projects = (json.projects ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  projects[cwd] = { ...(projects[cwd] ?? {}), hasTrustDialogAccepted: true };
  json.projects = projects;
  // 原子的に書き換える (常駐 CLI が読む共有ファイルのため破損を避ける)
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify(json, null, 2));
  await fs.promises.rename(tmp, file);
}
