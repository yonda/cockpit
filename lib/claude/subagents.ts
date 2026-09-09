import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SubagentSummary } from "@/lib/herdr/types";
import { lastTextBlock, readTail, resolveTranscriptPath, truncate } from "./recap";

// Claude Code の subagent (Agent ツール) は親と同じプロセスで動くので、
// herdr からは見えない。代わりに transcript を読む:
//   ~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.jsonl      本文
//   ~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.meta.json  種類と説明
// 動作中かどうかは本文の末尾から判断する (末尾が SubagentStop hook の記録、
// または stop_reason=end_turn の assistant 応答なら終了)。

export type SubagentStatus = "running" | "done" | "stale";

export type SubagentInfo = {
  agentId: string;
  // Agent ツールの subagent_type (例: repo-researcher, general-purpose)
  agentType: string;
  // スキル経由で起動したときの名前 (例: code-review)。無ければ null
  name: string | null;
  description: string | null;
  spawnDepth: number;
  status: SubagentStatus;
  lastMessage: string | null;
  updatedAt: string;
};

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
  spawnDepth: number;
};

export type ParsedTail = {
  // 末尾 (それ以降に本文の記録が無い位置) に SubagentStop hook の記録がある。
  // 一度止まった subagent が SendMessage で再開されると、その後に本文が続くので
  // 途中の SubagentStop は数えない
  endedByHook: boolean;
  // 最後の assistant 記録が stop_reason=end_turn (= 最終応答)。
  // 1 ターンは thinking / text / tool_use が別行で書かれるため、
  // 「最後の行に tool_use が無い」では途中の行を最終応答と誤認する
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
    spawnDepth: typeof data.spawnDepth === "number" ? data.spawnDepth : 1,
  };
}

export function parseTail(tail: string): ParsedTail {
  let endedByHook = false;
  let finalAnswer = false;
  let lastMessage: string | null = null;

  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    let record: {
      type?: string;
      attachment?: { hookEvent?: string };
      message?: { content?: unknown; stop_reason?: unknown };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "attachment") {
      const event = record.attachment?.hookEvent;
      if (event === "SubagentStop") endedByHook = true;
      else if (event === "SubagentStart") endedByHook = false;
      continue;
    }
    if (record.type === "assistant") {
      endedByHook = false;
      const text = lastTextBlock(record.message?.content);
      if (text) {
        const cleaned = truncate(text);
        if (cleaned) lastMessage = cleaned;
      }
      finalAnswer = record.message?.stop_reason === "end_turn";
    } else if (record.type === "user") {
      endedByHook = false;
      finalAnswer = false;
    }
  }

  return { endedByHook, finalAnswer, lastMessage };
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
  let info: { mtimeMs: number; size: number };
  try {
    const s = await stat(transcriptPath);
    info = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }

  let parsed: ParsedTail;
  const cached = tailCache.get(transcriptPath);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    parsed = cached.parsed;
  } else {
    try {
      parsed = parseTail(await readTail(transcriptPath, info.size, TAIL_BYTES));
    } catch {
      return null;
    }
    tailCache.set(transcriptPath, { ...info, parsed });
  }

  const meta = await readMeta(join(dir, `agent-${agentId}${META_SUFFIX}`));
  return {
    agentId,
    agentType: meta?.agentType ?? "agent",
    name: meta?.name ?? null,
    description: meta?.description ?? null,
    spawnDepth: meta?.spawnDepth ?? 1,
    status: resolveStatus(parsed, info.mtimeMs, now),
    lastMessage: parsed.lastMessage,
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
