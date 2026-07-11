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
import {
  canPbiTransition,
  canSubTaskTransition,
  type PbiEscalation,
  type PbiJob,
  type PbiStatus,
  type SubTaskRecord,
  type SubTaskState,
} from "../lib/pbi/types";

export class PbiStore extends EventEmitter {
  private pbis = new Map<string, PbiJob>();

  constructor(private readonly dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
  }

  loadAll(): void {
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const pbi = JSON.parse(
          readFileSync(join(this.dir, name), "utf8"),
        ) as PbiJob;
        this.pbis.set(pbi.id, pbi);
      } catch {
        // 壊れたファイルはスキップ（起動を止めない）
      }
    }
  }

  list(): PbiJob[] {
    return [...this.pbis.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(id: string): PbiJob | undefined {
    return this.pbis.get(id);
  }

  create(fields: {
    repo: string;
    issueNumber: number;
    title: string;
  }): PbiJob {
    const now = new Date().toISOString();
    const pbi: PbiJob = {
      id: `pbi-${Date.now()}-${randomUUID().slice(0, 8)}`,
      ...fields,
      status: "decomposing",
      paused: false,
      subTasks: [],
      escalations: [],
      decompositionAttempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.save(pbi);
    return pbi;
  }

  transition(id: string, to: PbiStatus, patch: Partial<PbiJob> = {}): PbiJob {
    const pbi = this.mustGet(id);
    if (!canPbiTransition(pbi.status, to)) {
      throw new Error(`invalid transition: ${pbi.status} -> ${to} (${id})`);
    }
    return this.save({ ...pbi, ...patch, status: to });
  }

  update(id: string, patch: Partial<PbiJob>): PbiJob {
    const pbi = this.mustGet(id);
    if ("status" in patch && patch.status !== pbi.status) {
      throw new Error("use transition() to change status");
    }
    return this.save({ ...pbi, ...patch });
  }

  setSubTasks(id: string, subTasks: SubTaskRecord[]): PbiJob {
    return this.save({ ...this.mustGet(id), subTasks });
  }

  transitionSubTask(
    id: string,
    key: string,
    to: SubTaskState,
    patch: Partial<SubTaskRecord> = {},
  ): PbiJob {
    const pbi = this.mustGet(id);
    const subTasks = pbi.subTasks.map((t) => {
      if (t.key !== key) return t;
      if (!canSubTaskTransition(t.state, to)) {
        throw new Error(
          `invalid sub-task transition: ${t.state} -> ${to} (${id}/${key})`,
        );
      }
      return { ...t, ...patch, state: to };
    });
    return this.save({ ...pbi, subTasks });
  }

  addEscalation(
    id: string,
    esc: Omit<PbiEscalation, "id" | "createdAt">,
  ): PbiJob {
    const pbi = this.mustGet(id);
    const full: PbiEscalation = {
      ...esc,
      id: `esc-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
    };
    return this.save({ ...pbi, escalations: [...pbi.escalations, full] });
  }

  clearEscalation(id: string, escId: string): PbiJob {
    const pbi = this.mustGet(id);
    return this.save({
      ...pbi,
      escalations: pbi.escalations.filter((e) => e.id !== escId),
    });
  }

  private mustGet(id: string): PbiJob {
    const pbi = this.pbis.get(id);
    if (!pbi) throw new Error(`unknown pbi: ${id}`);
    return pbi;
  }

  private save(pbi: PbiJob): PbiJob {
    const next = { ...pbi, updatedAt: new Date().toISOString() };
    this.pbis.set(next.id, next);
    const path = join(this.dir, `${next.id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    this.emit("pbi", next);
    return next;
  }
}
