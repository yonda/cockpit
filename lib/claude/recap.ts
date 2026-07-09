import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaneRecap } from "@/lib/herdr/types";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
// ai-title はユーザーターンごとに書かれる (実測 ~20 行間隔) ため、
// 末尾だけ読めば title・直近のやりとりが揃う
const TAIL_BYTES = 256 * 1024;

type CacheEntry = { mtimeMs: number; size: number; recap: PaneRecap };
const recapCache = new Map<string, CacheEntry>();
const pathCache = new Map<string, string>();

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Claude Code のプロジェクト slug: パスの英数字以外を '-' に置換したもの
function projectSlug(dir: string): string {
  return expandHome(dir).replace(/[^a-zA-Z0-9-]/g, "-");
}

async function resolveTranscriptPath(
  sessionId: string,
  cwds: string[],
): Promise<string | null> {
  const cached = pathCache.get(sessionId);
  if (cached) return cached;

  const candidates = cwds.map(
    (dir) => join(PROJECTS_DIR, projectSlug(dir), `${sessionId}.jsonl`),
  );
  for (const path of candidates) {
    try {
      await stat(path);
      pathCache.set(sessionId, path);
      return path;
    } catch {
      // try next candidate
    }
  }

  // cwd から slug が引けない場合 (worktree 等) は全プロジェクトを走査
  try {
    const dirs = await readdir(PROJECTS_DIR);
    for (const dir of dirs) {
      const path = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      try {
        await stat(path);
        pathCache.set(sessionId, path);
        return path;
      } catch {
        // not in this project
      }
    }
  } catch {
    // projects dir unreadable
  }
  return null;
}

function firstTextBlock(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: string }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}

function lastTextBlock(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: string }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

async function readTail(path: string, size: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    // 途中から読んだ場合、先頭の欠けた行を捨てる
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

function parseRecap(tail: string, mtimeMs: number): PaneRecap {
  let title: string | null = null;
  let lastPrompt: string | null = null;
  let lastAssistant: string | null = null;

  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    let record: {
      type?: string;
      aiTitle?: string;
      isSidechain?: boolean;
      message?: { role?: string; content?: unknown };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "ai-title" && record.aiTitle) {
      title = record.aiTitle;
    } else if (record.type === "user" && !record.isSidechain) {
      const text = firstTextBlock(record.message?.content);
      // tool_result のみの user レコード・割り込み/再開などの合成メタ行を除外
      if (
        text &&
        !text.startsWith("<") &&
        !text.startsWith("This session is being continued") &&
        !text.startsWith("[Request interrupted") &&
        !text.startsWith("Caveat:")
      ) {
        const cleaned = truncate(text);
        if (cleaned) {
          lastPrompt = cleaned;
          lastAssistant = null; // この指示より前の応答は古いので捨てる
        }
      }
    } else if (record.type === "assistant") {
      const text = lastTextBlock(record.message?.content);
      if (text) lastAssistant = truncate(text);
    }
  }

  return {
    title,
    lastPrompt,
    lastAssistant,
    lastActivityAt: new Date(mtimeMs).toISOString(),
  };
}

export async function readSessionRecap(
  sessionId: string,
  cwds: string[],
): Promise<PaneRecap | null> {
  const path = await resolveTranscriptPath(sessionId, cwds);
  if (!path) return null;

  let info: { mtimeMs: number; size: number };
  try {
    const s = await stat(path);
    info = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    pathCache.delete(sessionId);
    return null;
  }

  const cached = recapCache.get(sessionId);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.recap;
  }

  try {
    const tail = await readTail(path, info.size);
    const recap = parseRecap(tail, info.mtimeMs);
    recapCache.set(sessionId, { ...info, recap });
    return recap;
  } catch {
    return null;
  }
}
