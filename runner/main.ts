import { homedir } from "node:os";
import { join } from "node:path";
import { JOBS_DIR, RUNNER_SOCKET_PATH } from "../lib/jobs/types";
import { RealCommandRunner } from "./exec";
import { InputBroker } from "./input-broker";
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
  const scheduler = new Scheduler({
    store,
    broker,
    commands: new RealCommandRunner(),
    executor: new SdkExecutor(),
    repoDir: REPO_DIR,
  });

  startRunnerServer(RUNNER_SOCKET_PATH, { store, scheduler, broker });
  scheduler.resumeOnBoot();

  console.log(
    `[runner] listening on ${RUNNER_SOCKET_PATH} (repo: ${REPO_DIR}, jobs: ${JOBS_DIR})`,
  );
}

main();
