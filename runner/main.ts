import { JOBS_DIR, RUNNER_SOCKET_PATH } from "../lib/jobs/types";
import { PBIS_DIR } from "../lib/pbi/types";
import { realPrepareCwd } from "./decompose";
import { RealCommandRunner } from "./exec";
import { RealGitHubClient } from "./github";
import { InputBroker } from "./input-broker";
import type { PbiServerDeps } from "./pbi-server";
import { PbiStore } from "./pbi-store";
import { Scheduler } from "./scheduler";
import { SdkExecutor } from "./sdk-executor";
import { startRunnerServer } from "./server";
import { JobStore } from "./store";

// メインリポジトリの場所。launchd の WorkingDirectory がリポジトリルート。
const REPO_DIR = process.env.COCKPIT_REPO_DIR ?? process.cwd();

function main(): void {
  const store = new JobStore(JOBS_DIR);
  store.loadAll();
  const broker = new InputBroker();
  const commands = new RealCommandRunner();
  const scheduler = new Scheduler({
    store,
    broker,
    commands,
    executor: new SdkExecutor(),
    repoDir: REPO_DIR,
  });

  // PBI オーケストレーション依存の配線。起動時復旧（発射済みジョブとの再接続・
  // ポーラー起動）は Task 12 で追加する。
  const pbiStore = new PbiStore(PBIS_DIR);
  pbiStore.loadAll();
  const pbi: PbiServerDeps = {
    pbiStore,
    lifecycle: {
      store: pbiStore,
      executor: new SdkExecutor(),
      github: new RealGitHubClient(commands, REPO_DIR),
      prepareCwd: realPrepareCwd(commands, REPO_DIR),
    },
    exec: { pbiStore, jobStore: store, scheduler },
  };

  startRunnerServer(RUNNER_SOCKET_PATH, { store, scheduler, broker, pbi });
  scheduler.resumeOnBoot();

  console.log(
    `[runner] listening on ${RUNNER_SOCKET_PATH} (repo: ${REPO_DIR}, jobs: ${JOBS_DIR})`,
  );
}

main();
