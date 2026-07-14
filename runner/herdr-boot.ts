import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentExecutor } from "./executor";
import { HerdrExecutor } from "./herdr-executor";
import { RealHerdrClient, RealTranscriptReader } from "./herdr-real";
import { assertUnifiedProfile } from "./profile-check";

// 垂直スライス (#58) の配線: 既定は SdkExecutor のまま、env でオプトインしたときだけ
// HerdrExecutor を使う。常駐デーモンの実行系を初回スライスで丸ごと差し替えないための
// 安全弁 (dogfood は 1 ジョブを HerdrExecutor で流して比較する)。
//
//   COCKPIT_EXECUTOR=herdr           … HerdrExecutor を有効化
//   COCKPIT_HERDR_WORKSPACE=<wsId>   … タブを作る herdr ワークスペース ID (必須)
//
// 実行環境統一 (#85): settings は注入しない。spawn された claude は人間と同じ
// ユーザー settings (~/.claude/settings.json) を継承する。代わりに、無人実行の
// 安全性が依存する不変条件 (層3 deny・sandbox 有効等) を起動時に検証し、
// 満たさなければ fail-closed で起動を拒否する (runner/profile-check.ts)。

export function buildHerdrExecutorFromEnv(): AgentExecutor | null {
  if (process.env.COCKPIT_EXECUTOR !== "herdr") return null;
  const workspaceId = process.env.COCKPIT_HERDR_WORKSPACE;
  if (!workspaceId) {
    throw new Error(
      "COCKPIT_EXECUTOR=herdr には COCKPIT_HERDR_WORKSPACE (herdr ワークスペース ID) が必要です",
    );
  }
  assertUnifiedProfile();
  return new HerdrExecutor({
    herdr: new RealHerdrClient(),
    transcript: new RealTranscriptReader(),
    trustWorktree,
    workspaceId,
  });
}

// worktree を ~/.claude.json で明示 trust する (hasTrustDialogAccepted)。
// これが無いと CLI が worktree 側 settings の allow を untrusted として無視する
// (PoC E2)。deny/sandbox は trust の有無に関わらず効くが、正常系の allow を通すため
// dispatcher が spawn 前に付与する。
// ~/.claude.json は常駐 CLI・全 herdr セッションが読み書きする共有ファイルのため、
// read-modify-write が重なると lost-update が起きる。同一プロセス内の trustWorktree
// 呼び出しを直列化して、少なくとも runner 内の競合はなくす (プロセス跨ぎの CLI との
// 競合は残る既知の制約。将来 CLAUDE_CONFIG_DIR で config を分離するのが本筋)。
let trustChain: Promise<void> = Promise.resolve();

export function trustWorktree(
  cwd: string,
  claudeJsonPath: string = path.join(os.homedir(), ".claude.json"),
): Promise<void> {
  const next = trustChain.then(() => trustWorktreeUnsafe(cwd, claudeJsonPath));
  // チェーンは失敗しても次を止めない (直列化のためだけに使う)
  trustChain = next.catch(() => {});
  return next;
}

async function trustWorktreeUnsafe(
  cwd: string,
  file: string,
): Promise<void> {
  let json: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (err) {
    // ファイル未作成 (ENOENT) のときだけ空から作る。それ以外の読み取りエラーは
    // 権限問題等の可能性があり、握りつぶすと下の全書き換えで実ファイルを壊すため throw。
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw !== null) {
    // 読めたのにパースできない = 破損 or 書き込み途中。ここで {} にフォールバックして
    // 全書き換えすると ~/.claude.json (全 project trust・認証状態・履歴) を丸ごと
    // 消してしまう。データ損失を避けるため throw して中断する (呼び出し側で失敗扱い)。
    json = JSON.parse(raw) as Record<string, unknown>;
  }
  const projects = (json.projects ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  projects[cwd] = { ...(projects[cwd] ?? {}), hasTrustDialogAccepted: true };
  json.projects = projects;
  // 原子的に書き換える (torn write を避ける)。lost-update は上のチェーンで直列化。
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify(json, null, 2));
  await fs.promises.rename(tmp, file);
}
