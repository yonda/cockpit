import { JOBS_DIR, RUNNER_SOCKET_PATH } from "../lib/jobs/types";
import { PBIS_DIR, PBI_POLL_INTERVAL_MS } from "../lib/pbi/types";
import { realPrepareCwd } from "./decompose";
import { RealCommandRunner } from "./exec";
import { RealGitHubClient } from "./github";
import { resolveToken } from "./github-token";
import type { AgentExecutor } from "./executor";
import { buildHerdrExecutorFromEnv } from "./herdr-boot";
import { InputBroker } from "./input-broker";
import { onJobUpdated, type PbiExecutorDeps } from "./pbi-executor";
import { reconcileOnBoot } from "./pbi-boot";
import type { LifecycleDeps } from "./pbi-lifecycle";
import { startPoller } from "./pbi-poller";
import type { PbiServerDeps } from "./pbi-server";
import { PbiStore } from "./pbi-store";
import { loadRegistry } from "./repo-registry";
import { Scheduler } from "./scheduler";
import { SdkExecutor } from "./sdk-executor";
import { startRunnerServer } from "./server";
import { JobStore } from "./store";

function main(): void {
  // 構造ガード (Issue #54): グローバル単一 GH_TOKEN の起動時セットは撤廃した
  // (旧 applyRunnerToken)。マルチリポジトリ配線 (Task 8) では、ジョブ・分解ごとに
  // repo-registry で対象リポジトリを解決し、その tokenOwner で resolveToken(owner)
  // を呼んで owner 限定の fine-grained PAT を取得する (fail-closed: ファイルが
  // 無ければそのジョブを失敗させる。keyring の強い classic token への silent
  // fallback をしない)。
  const registry = loadRegistry();

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
    implementExecutor = buildHerdrExecutorFromEnv() ?? implementExecutor;
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
    registry,
    resolveToken,
  });

  // PBI オーケストレーション依存の配線。
  const pbiStore = new PbiStore(PBIS_DIR);
  pbiStore.loadAll();
  const github = new RealGitHubClient(commands, resolveToken);
  const exec: PbiExecutorDeps = { pbiStore, jobStore: store, scheduler, github };
  const lifecycle: LifecycleDeps = {
    store: pbiStore,
    executor: new SdkExecutor(),
    github,
    prepareCwd: realPrepareCwd(commands, registry, resolveToken),
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
    `[runner] listening on ${RUNNER_SOCKET_PATH} (repos: ${registry.all().length}, jobs: ${JOBS_DIR}, pbis: ${PBIS_DIR})`,
  );
}

main();
