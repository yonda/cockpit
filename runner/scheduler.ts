import { runIssueJob, type WorkflowDeps } from "./workflow";

export class Scheduler {
  private active = new Map<string, AbortController>();
  private readonly maxConcurrent: number;
  private readonly runJob: typeof runIssueJob;

  constructor(
    private readonly deps: WorkflowDeps,
    opts: { maxConcurrent?: number; runJob?: typeof runIssueJob } = {},
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.runJob = opts.runJob ?? runIssueJob;
  }

  /** 空きスロットがあれば古い順に queued ジョブを開始する */
  poke(): void {
    if (this.active.size >= this.maxConcurrent) return;
    const queued = this.deps.store
      .list()
      .filter((j) => j.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of queued) {
      if (this.active.size >= this.maxConcurrent) break;
      this.start(job.id);
    }
  }

  private start(jobId: string): void {
    const controller = new AbortController();
    this.active.set(jobId, controller);
    void this.runJob(this.deps, jobId, controller.signal)
      .catch(() => {
        // runIssueJob 内で failed 遷移済み。ここは取りこぼし防止のみ
      })
      .finally(() => {
        this.active.delete(jobId);
        this.poke();
      });
  }

  cancel(jobId: string): void {
    const controller = this.active.get(jobId);
    if (controller) controller.abort();
    this.deps.broker.abort(jobId);
    const job = this.deps.store.get(jobId);
    if (job && ["queued", "running", "waiting_input"].includes(job.status)) {
      this.deps.store.transition(jobId, "cancelled", { pendingInput: null });
    }
  }

  /**
   * 起動時復旧: 前回プロセスが落ちたときに running / waiting_input で
   * 残っているジョブを、session があれば resume 再実行、なければ failed にする。
   */
  resumeOnBoot(): void {
    for (const job of this.deps.store.list()) {
      if (!["running", "waiting_input"].includes(job.status)) continue;
      if (job.sessionId && job.worktreePath) {
        // runIssueJob は running 遷移から始まるので一度 queued 相当に見せる
        // (waiting_input -> running は合法遷移なのでそのまま start してよい)
        this.deps.store.update(job.id, { pendingInput: null });
        this.start(job.id);
      } else {
        this.deps.store.transition(job.id, "failed", {
          error: "runner 再起動時に復旧できませんでした (session なし)",
          pendingInput: null,
        });
      }
    }
    this.poke();
  }
}
