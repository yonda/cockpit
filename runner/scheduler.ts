import { runIssueJob, type WorkflowDeps } from "./workflow";

export class Scheduler {
  private active = new Map<string, AbortController>();
  private pendingResume: string[] = [];
  private readonly maxConcurrent: number;
  private readonly runJob: typeof runIssueJob;

  constructor(
    private readonly deps: WorkflowDeps,
    opts: { maxConcurrent?: number; runJob?: typeof runIssueJob } = {},
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.runJob = opts.runJob ?? runIssueJob;
  }

  /** 空きスロットがあれば resume 待ち → queued の順に開始する */
  poke(): void {
    while (
      this.active.size < this.maxConcurrent &&
      this.pendingResume.length > 0
    ) {
      const id = this.pendingResume.shift()!;
      const job = this.deps.store.get(id);
      // resume 待ちの間にキャンセル等で状態が変わったものは飛ばす
      if (!job || !["running", "waiting_input"].includes(job.status)) continue;
      this.start(id);
    }
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
    const interrupted = this.deps.store
      .list()
      .filter((j) => ["running", "waiting_input"].includes(j.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of interrupted) {
      if (job.sessionId && job.worktreePath) {
        this.deps.store.update(job.id, { pendingInput: null });
        this.pendingResume.push(job.id);
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
