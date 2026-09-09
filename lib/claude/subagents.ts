import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveTranscriptPath } from "./recap";

// Claude Code の subagent (Agent ツール) は親と同じプロセスで動くので、
// herdr からは見えない。代わりに transcript を読む:
//   ~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.jsonl      本文
//   ~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.meta.json  種類と説明
// 動作中かどうかは本文の末尾から判断する (SubagentStop hook の記録、
// または tool_use を伴わない assistant の最終応答があれば終了)。

export type SubagentStatus = "running" | "done" | "stale";

export type SubagentInfo = {
  agentId: string;
  // Agent ツールの subagent_type (例: repo-researcher, general-purpose)
  agentType: string;
  // スキル経由で起動したときの名前 (例: code-review)。無ければ null
  name: string | null;
  description: string | null;
  parentAgentId: string | null;
  spawnDepth: number;
  status: SubagentStatus;
  lastMessage: string | null;
  startedAt: string | null;
  updatedAt: string;
};

export type SubagentSummary = { running: number; total: number };

const TAIL_BYTES = 64 * 1024;
// 終了の記録が無いまま更新が止まって 30 分経ったら、止まったものとみなす
// (割り込みやプロセス終了で SubagentStop が書かれないことがある)
export const STALE_AFTER_MS = 30 * 60 * 1000;
const META_SUFFIX = ".meta.json";
const TRANSCRIPT_SUFFIX = ".jsonl";

type Meta = {
  agentType: string;
  name: string | null;
  description: string | null;
  parentAgentId: string | null;
  spawnDepth: number;
};

export type ParsedTail = {
  // SubagentStop hook の記録が末尾側にある
  endedByHook: boolean;
  // 最後の主要レコードが tool_use を伴わない assistant (= 最終応答)
  finalAnswer: boolean;
  lastMessage: string | null;
};

type TailCacheEntry = { mtimeMs: number; size: number; parsed: ParsedTail };
const tailCache = new Map<string, TailCacheEntry>();
const metaCache = new Map<string, Meta | null>();

export function parseMeta(raw: string): Meta | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    agentType: str(data.agentType) ?? "agent",
    name: str(data.name),
    description: str(data.description),
    parentAgentId: str(data.parentAgentId),
    spawnDepth: typeof data.spawnDepth === "number" ? data.spawnDepth : 1,
  };
}

function lastTextBlock(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: string; text?: string } | null;
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
}

function hasToolUse(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_use",
    )
  );
}

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function parseTail(tail: string): ParsedTail {
  let endedByHook = false;
  let lastMain: { type: string; toolUse: boolean } | null = null;
  let lastMessage: string | null = null;

  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    let record: {
      type?: string;
      attachment?: { hookEvent?: string };
      message?: { content?: unknown };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "attachment") {
      if (record.attachment?.hookEvent === "SubagentStop") endedByHook = true;
      continue;
    }
    if (record.type === "assistant") {
      const content = record.message?.content;
      const text = lastTextBlock(content);
      if (text) {
        const cleaned = truncate(text);
        if (cleaned) lastMessage = cleaned;
      }
      lastMain = { type: "assistant", toolUse: hasToolUse(content) };
    } else if (record.type === "user") {
      lastMain = { type: "user", toolUse: false };
    }
  }

  return {
    endedByHook,
    finalAnswer: lastMain?.type === "assistant" && !lastMain.toolUse,
    lastMessage,
  };
}

export function resolveStatus(
  parsed: ParsedTail,
  mtimeMs: number,
  now: number,
): SubagentStatus {
  if (parsed.endedByHook || parsed.finalAnswer) return "done";
  return now - mtimeMs > STALE_AFTER_MS ? "stale" : "running";
}

const STATUS_RANK: Record<SubagentStatus, number> = { running: 0, done: 1, stale: 2 };

export function sortSubagents(list: SubagentInfo[]): SubagentInfo[] {
  return list.slice().sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank !== 0) return rank;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function summarizeSubagents(list: SubagentInfo[]): SubagentSummary {
  return {
    running: list.filter((s) => s.status === "running").length,
    total: list.length,
  };
}

// "<dir>/<session-id>.jsonl" → "<dir>/<session-id>/subagents"
export function subagentsDirFor(transcriptPath: string): string {
  const base = transcriptPath.endsWith(TRANSCRIPT_SUFFIX)
    ? transcriptPath.slice(0, -TRANSCRIPT_SUFFIX.length)
    : transcriptPath;
  return join(base, "subagents");
}

async function readTail(path: string, size: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

async function readMeta(path: string): Promise<Meta | null> {
  const cached = metaCache.get(path);
  if (cached !== undefined) return cached;
  let meta: Meta | null = null;
  try {
    meta = parseMeta(await readFile(path, "utf8"));
  } catch {
    meta = null;
  }
  // meta.json は起動時に 1 度書かれるだけなので、読めたら固定でよい
  if (meta) metaCache.set(path, meta);
  return meta;
}

async function readOne(
  dir: string,
  agentId: string,
  now: number,
): Promise<SubagentInfo | null> {
  const transcriptPath = join(dir, `agent-${agentId}${TRANSCRIPT_SUFFIX}`);
  let info: { mtimeMs: number; size: number; birthtimeMs: number };
  try {
    const s = await stat(transcriptPath);
    info = { mtimeMs: s.mtimeMs, size: s.size, birthtimeMs: s.birthtimeMs };
  } catch {
    return null;
  }

  let parsed: ParsedTail;
  const cached = tailCache.get(transcriptPath);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    parsed = cached.parsed;
  } else {
    try {
      parsed = parseTail(await readTail(transcriptPath, info.size));
    } catch {
      return null;
    }
    tailCache.set(transcriptPath, { mtimeMs: info.mtimeMs, size: info.size, parsed });
  }

  const meta = await readMeta(join(dir, `agent-${agentId}${META_SUFFIX}`));
  return {
    agentId,
    agentType: meta?.agentType ?? "agent",
    name: meta?.name ?? null,
    description: meta?.description ?? null,
    parentAgentId: meta?.parentAgentId ?? null,
    spawnDepth: meta?.spawnDepth ?? 1,
    status: resolveStatus(parsed, info.mtimeMs, now),
    lastMessage: parsed.lastMessage,
    startedAt: info.birthtimeMs > 0 ? new Date(info.birthtimeMs).toISOString() : null,
    updatedAt: new Date(info.mtimeMs).toISOString(),
  };
}

// subagents ディレクトリ 1 つ分を読む。ディレクトリが無ければ空配列。
export async function readSubagentsDir(
  dir: string,
  now: number = Date.now(),
): Promise<SubagentInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const ids = entries
    .filter((f) => f.startsWith("agent-") && f.endsWith(TRANSCRIPT_SUFFIX))
    .map((f) => f.slice("agent-".length, -TRANSCRIPT_SUFFIX.length));
  const list = await Promise.all(ids.map((id) => readOne(dir, id, now)));
  return sortSubagents(list.filter((s): s is SubagentInfo => s !== null));
}

export async function readSessionSubagents(
  sessionId: string,
  cwds: string[],
): Promise<SubagentInfo[]> {
  const transcriptPath = await resolveTranscriptPath(sessionId, cwds);
  if (!transcriptPath) return [];
  return readSubagentsDir(subagentsDirFor(transcriptPath));
}
