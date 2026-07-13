import { JOBS_DIR, RUNNER_SOCKET_PATH } from "../lib/jobs/types";
import { PBIS_DIR, PBI_POLL_INTERVAL_MS } from "../lib/pbi/types";
import { realPrepareCwd } from "./decompose";
import { RealCommandRunner } from "./exec";
import { RealGitHubClient } from "./github";
import { applyRunnerToken } from "./github-token";
import type { AgentExecutor } from "./executor";
import { buildHerdrExecutorFromEnv } from "./herdr-boot";
import { InputBroker } from "./input-broker";
import { onJobUpdated, type PbiExecutorDeps } from "./pbi-executor";
import { reconcileOnBoot } from "./pbi-boot";
import type { LifecycleDeps } from "./pbi-lifecycle";
import { startPoller } from "./pbi-poller";
import type { PbiServerDeps } from "./pbi-server";
import { PbiStore } from "./pbi-store";
import { Scheduler } from "./scheduler";
import { SdkExecutor } from "./sdk-executor";
import { startRunnerServer } from "./server";
import { JobStore } from "./store";

// メインリポジトリの場所。launchd の WorkingDirectory がリポジトリルート。
const REPO_DIR = process.env.COCKPIT_REPO_DIR ?? process.cwd();

function main(): void {
  // 構造ガード (Issue #54): 何より先に weak PAT (yonda/cockpit 限定の
  // fine-grained PAT) を GH_TOKEN へ積む。以降の gh 呼び出し (runner 自身の
  // ポーリングと spawn したエージェント) はすべてこのトークンで動く。
  // ファイルが無ければここで throw して起動しない (fail-closed。keyring の
  // 強い classic token への silent fallback をしない)。launchd の KeepAlive は
  // 10 秒スロットルで再試行し続けるため、ファイルを配置すれば自動復旧する。
  // 未配置のままのデプロイは bin/service の check_runner_token が preflight で防ぐ。
  applyRunnerToken();

  const store = new JobStore(JOBS_DIR);
  store.loadAll();
  const broker = new InputBroker();
  const commands = new RealCommandRunner();

  // 実装ジョブの executor。既定は SdkExecutor、COCKPIT_EXECUTOR=herdr のときだけ
  // HerdrExecutor (herdr ペイン実行) に差し替える (#58 垂直スライスのオプトイン配線)。
  // 分解ジョブ (lifecycle) は headless の読み取り解析なので SdkExecutor のまま。
  // オプトインの設定不備で HerdrExecutor 構築が throw しても、デーモン全体 (分解・
  // lifecycle 含む) を落とさず SdkExecutor に degrade する (herdr 経路だけ無効化)。
  let implementExecutor: AgentExecutor = new SdkExecutor();
  try {
    implementExecutor = buildHerdrExecutorFromEnv(REPO_DIR) ?? implementExecutor;
  } catch (err) {
    console.error(
      `[runner] HerdrExecutor 構築に失敗したため SdkExecutor に degrade します: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (implementExecutor.constructor.name === "HerdrExecutor") {
    console.log("[runner] implement executor: HerdrExecutor (herdr pane)");
  }
  const scheduler = new Scheduler({
    store,
    broker,
    commands,
    executor: implementExecutor,
    repoDir: REPO_DIR,
  });

  // PBI オーケストレーション依存の配線。
  const pbiStore = new PbiStore(PBIS_DIR);
  pbiStore.loadAll();
  const github = new RealGitHubClient(commands, REPO_DIR);
  const exec: PbiExecutorDeps = { pbiStore, jobStore: store, scheduler, github };
  const lifecycle: LifecycleDeps = {
    store: pbiStore,
    executor: new SdkExecutor(),
    github,
    prepareCwd: realPrepareCwd(commands, REPO_DIR),
  };
  const pbi: PbiServerDeps = { pbiStore, lifecycle, exec };

  // Launch Pad ジョブの状態変化を PBI に反映（PR 作成 → in_review、以降のマージ
  // 検知はポーラーが担う）。
  store.on("job", (job) => {
    void onJobUpdated(exec, job).catch((err) => {
      console.error(
        `[runner] onJobUpdated failed (${job.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  startRunnerServer(RUNNER_SOCKET_PATH, { store, scheduler, broker, pbi });
  scheduler.resumeOnBoot();
  reconcileOnBoot({ pbiStore, exec });
  startPoller({ pbiStore, github, exec }, PBI_POLL_INTERVAL_MS);

  console.log(
    `[runner] listening on ${RUNNER_SOCKET_PATH} (repo: ${REPO_DIR}, jobs: ${JOBS_DIR}, pbis: ${PBIS_DIR})`,
  );
}

main();
