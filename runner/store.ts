import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canTransition, type Job, type JobStatus } from "../lib/jobs/types";

export class JobStore extends EventEmitter {
  private jobs = new Map<string, Job>();

  constructor(private readonly dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
  }

  loadAll(): void {
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(
          readFileSync(join(this.dir, name), "utf8"),
        ) as Job;
        this.jobs.set(job.id, job);
      } catch {
        // 壊れたファイルはスキップ (起動を止めない)
      }
    }
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  create(fields: {
    repo: string;
    issueNumber: number;
    issueTitle: string;
    branch: string;
  }): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: `job-${Date.now()}-${randomUUID().slice(0, 8)}`,
      ...fields,
      worktreePath: null,
      status: "queued",
      sessionId: null,
      pendingInput: null,
      prUrl: null,
      error: null,
      lastActivity: null,
      createdAt: now,
      updatedAt: now,
    };
    this.save(job);
    return job;
  }

  transition(id: string, to: JobStatus, patch: Partial<Job> = {}): Job {
    const job = this.mustGet(id);
    if (!canTransition(job.status, to)) {
      throw new Error(`invalid transition: ${job.status} -> ${to} (${id})`);
    }
    return this.save({ ...job, ...patch, status: to });
  }

  update(id: string, patch: Partial<Job>): Job {
    const job = this.mustGet(id);
    if (patch.status && patch.status !== job.status) {
      throw new Error("use transition() to change status");
    }
    return this.save({ ...job, ...patch });
  }

  private mustGet(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job: ${id}`);
    return job;
  }

  private save(job: Job): Job {
    const next = { ...job, updatedAt: new Date().toISOString() };
    this.jobs.set(next.id, next);
    // 書きかけファイルを読まれないよう atomic write
    const path = join(this.dir, `${next.id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    this.emit("job", next);
    return next;
  }
}
