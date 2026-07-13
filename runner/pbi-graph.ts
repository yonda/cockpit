import type { SubTaskRecord } from "../lib/pbi/types";

const DONE = new Set(["merged", "done_no_pr", "skipped"]);

export function readySubTasks(subTasks: SubTaskRecord[]): SubTaskRecord[] {
  const byKey = new Map(subTasks.map((t) => [t.key, t]));
  return subTasks.filter((t) => {
    if (t.state !== "pending") return false;
    return t.dependsOn.every((dep) => {
      const d = byKey.get(dep);
      return d != null && DONE.has(d.state);
    });
  });
}

export function isPbiComplete(subTasks: SubTaskRecord[]): boolean {
  return subTasks.length > 0 && subTasks.every((t) => DONE.has(t.state));
}

export function hasBlockedProgress(subTasks: SubTaskRecord[]): boolean {
  if (isPbiComplete(subTasks)) return false;
  const anyRunning = subTasks.some((t) =>
    ["running", "in_review"].includes(t.state),
  );
  if (anyRunning) return false;
  return readySubTasks(subTasks).length === 0;
}

export function validateDependencies(subTasks: SubTaskRecord[]): string | null {
  const keys = new Set(subTasks.map((t) => t.key));
  for (const t of subTasks) {
    for (const dep of t.dependsOn) {
      if (!keys.has(dep)) {
        return `未知の依存 key を参照しています: ${t.key} -> ${dep}`;
      }
    }
  }
  // 循環検出（DFS）
  const byKey = new Map(subTasks.map((t) => [t.key, t]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): boolean => {
    const s = state.get(key);
    if (s === "done") return false;
    if (s === "visiting") return true; // 循環
    state.set(key, "visiting");
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (visit(dep)) return true;
    }
    state.set(key, "done");
    return false;
  };
  for (const t of subTasks) {
    if (visit(t.key)) return `依存に循環があります (${t.key} を含む)`;
  }
  return null;
}
