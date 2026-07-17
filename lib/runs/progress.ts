import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * issue-driver skill が issue ごとに書く進捗ファイル(観測契約)の型・パース検証・
 * 原子的書き込みヘルパー。スキーマは docs/superpowers/specs/2026-07-14-issue-driver-skill-design.md
 * および .claude/skills/issue-driver/SKILL.md の §進捗ファイル に一致させる。
 *
 * GitHub 権威の事実(PR のマージ状態・sub-issue の open/close 等)はここに含めない。
 * `subIssue` / `prNumber` は参照番号のみを持つ。
 */

export type ProgressPhase =
  | "understanding"
  | "decomposing"
  | "implementing"
  | "reviewing"
  | "monitoring"
  | "done"
  | "escalated";

export type LiveStatus =
  | "queued"
  | "implementing"
  | "reviewing"
  | "blocked"
  | "handed_off";

export type EscalationReason = "spec_conflict" | "external_impact" | "blocker";

export type ProgressEscalation = {
  reason: EscalationReason;
  detail: string;
  options: string[];
  recommendation: string;
  at: string;
};

/**
 * monitoring に入った issue-driver(lead)の「担当セッションの連絡先」。
 * cockpit の wake 機構(#168)が「生きていれば つつく／死んでいたら 立て直す」を
 * 判断するために使う。GitHub 権威の事実ではなく、ライブ層(セッションの所在)を指す。
 *
 * - agmsgTeam / agmsgAgent: つつく(agmsg send)先。生死判定(ready sentinel)にも使う。
 * - herdrPane: herdr 上のペイン/エージェント target(生死判定・立て直しの配置に使う)。
 * - cwd: 立て直し時に使う worktree の絶対パス。
 * どれも不明なら null。
 */
export type ProgressSession = {
  agmsgTeam: string | null;
  agmsgAgent: string | null;
  herdrPane: string | null;
  cwd: string | null;
};

export type ProgressNode = {
  key: string;
  title: string;
  /**
   * このノードの sub-issue/PR が居るリポジトリ("owner/name")。省略時は run の repo。
   * 親 issue と別のリポジトリに sub-issue/PR を作る横断タスク用。
   */
  repo?: string;
  dependsOn: string[];
  liveStatus: LiveStatus;
  /** 人が読む一行(任意)。例: "実装中: xxx を追加" */
  activity?: string;
  /** GitHub 参照(なければ null)。マージ状態などは持たない */
  subIssue: number | null;
  /** GitHub 参照(なければ null)。マージ状態などは持たない */
  prNumber: number | null;
  escalation: ProgressEscalation | null;
};

export type ProgressFile = {
  schemaVersion: number;
  repo: string;
  issueNumber: number;
  title: string;
  phase: ProgressPhase;
  updatedAt: string;
  escalation: ProgressEscalation | null;
  /** 担当セッションの連絡先(wake 機構用)。無ければ null。#168 で追加。 */
  session: ProgressSession | null;
  nodes: ProgressNode[];
};

const PHASES: readonly ProgressPhase[] = [
  "understanding",
  "decomposing",
  "implementing",
  "reviewing",
  "monitoring",
  "done",
  "escalated",
];

const LIVE_STATUSES: readonly LiveStatus[] = [
  "queued",
  "implementing",
  "reviewing",
  "blocked",
  "handed_off",
];

const ESCALATION_REASONS: readonly EscalationReason[] = [
  "spec_conflict",
  "external_impact",
  "blocker",
];

function fail(path: string, message: string): never {
  throw new Error(`progress file: ${path}: ${message}`);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "object を期待した");
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "string を期待した");
  return value;
}

function assertNumber(value: unknown, path: string): number {
  if (typeof value !== "number") fail(path, "number を期待した");
  return value;
}

function assertStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    fail(path, "string[] を期待した");
  }
  return value as string[];
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `${allowed.join(" | ")} のいずれかを期待したが ${JSON.stringify(value)} だった`);
  }
  return value as T;
}

function parseEscalation(value: unknown, path: string): ProgressEscalation | null {
  if (value === null) return null;
  const obj = assertRecord(value, path);
  return {
    reason: assertEnum(obj.reason, ESCALATION_REASONS, `${path}.reason`),
    detail: assertString(obj.detail, `${path}.detail`),
    options: assertStringArray(obj.options, `${path}.options`),
    recommendation: assertString(obj.recommendation, `${path}.recommendation`),
    at: assertString(obj.at, `${path}.at`),
  };
}

function assertNullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  return assertString(value, path);
}

function parseSession(value: unknown, path: string): ProgressSession | null {
  if (value === undefined || value === null) return null;
  const obj = assertRecord(value, path);
  return {
    agmsgTeam: assertNullableString(obj.agmsgTeam, `${path}.agmsgTeam`),
    agmsgAgent: assertNullableString(obj.agmsgAgent, `${path}.agmsgAgent`),
    herdrPane: assertNullableString(obj.herdrPane, `${path}.herdrPane`),
    cwd: assertNullableString(obj.cwd, `${path}.cwd`),
  };
}

function parseNode(value: unknown, path: string): ProgressNode {
  const obj = assertRecord(value, path);
  const node: ProgressNode = {
    key: assertString(obj.key, `${path}.key`),
    title: assertString(obj.title, `${path}.title`),
    dependsOn: assertStringArray(obj.dependsOn, `${path}.dependsOn`),
    liveStatus: assertEnum(obj.liveStatus, LIVE_STATUSES, `${path}.liveStatus`),
    subIssue: obj.subIssue === null ? null : assertNumber(obj.subIssue, `${path}.subIssue`),
    prNumber: obj.prNumber === null ? null : assertNumber(obj.prNumber, `${path}.prNumber`),
    escalation: parseEscalation(obj.escalation ?? null, `${path}.escalation`),
  };
  if (obj.repo !== undefined) {
    node.repo = assertString(obj.repo, `${path}.repo`);
  }
  if (obj.activity !== undefined) {
    node.activity = assertString(obj.activity, `${path}.activity`);
  }
  return node;
}

/**
 * 進捗ファイルの JSON 文字列をパースし、スキーマに従って検証する。
 * 必須フィールドの欠落や不正な enum 値があれば、該当パスを含むメッセージ付きで throw する。
 */
export function parseProgress(json: string): ProgressFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`progress file: 不正な JSON: ${(e as Error).message}`);
  }
  const obj = assertRecord(raw, "$");
  const nodesRaw = obj.nodes;
  if (!Array.isArray(nodesRaw)) fail("$.nodes", "array を期待した");

  return {
    schemaVersion: assertNumber(obj.schemaVersion, "$.schemaVersion"),
    repo: assertString(obj.repo, "$.repo"),
    issueNumber: assertNumber(obj.issueNumber, "$.issueNumber"),
    title: assertString(obj.title, "$.title"),
    phase: assertEnum(obj.phase, PHASES, "$.phase"),
    updatedAt: assertString(obj.updatedAt, "$.updatedAt"),
    escalation: parseEscalation(obj.escalation ?? null, "$.escalation"),
    session: parseSession(obj.session ?? null, "$.session"),
    nodes: nodesRaw.map((n, i) => parseNode(n, `$.nodes[${i}]`)),
  };
}

/**
 * 進捗ファイルを原子的に書く(一時ファイルに書いて rename で置換)。
 * cockpit が読みかけの JSON を掴まないための書き込み規律(観測契約)。
 * 親ディレクトリが無ければ作成する。
 */
export function writeProgressAtomic(path: string, data: ProgressFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  try {
    renameSync(tmpPath, path);
  } catch (e) {
    rmSync(tmpPath, { force: true });
    throw e;
  }
}
