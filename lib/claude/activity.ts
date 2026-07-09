import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const INITIAL_CHUNK = 256 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;
const CONCURRENCY = 16;

// あなたが Claude Code に投げたプロンプト 1 つ = 1 イベント
export type ClaudeActivityEvent = {
  key: string;
  kind: "prompt";
  at: string; // ISO
  body: string;
  project: string;
  branch: string | null;
  sessionTitle: string | null;
};

type ParseResult = {
  events: ClaudeActivityEvent[];
  // このチャンクがカバーする最古のレコード時刻 (ms)。0 = ファイル全体を読んだ
  coveredFromMs: number;
};

type CacheEntry = ParseResult & { mtimeMs: number; size: number };
const cache = new Map<string, CacheEntry>();

function isMetaPrompt(text: string): boolean {
  return (
    text.startsWith("<") ||
    text.startsWith("This session is being continued") ||
    text.startsWith("[Request interrupted") ||
    text.startsWith("Caveat:")
  );
}

function firstText(content: unknown): string | null {
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

function oneLine(text: string, max = 300): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function readChunk(path: string, size: number, chunk: number): Promise<{ text: string; wholeFile: boolean }> {
  const start = Math.max(0, size - chunk);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, wholeFile: start === 0 };
  } finally {
    await handle.close();
  }
}

function parseChunk(text: string, sessionId: string, wholeFile: boolean): ParseResult {
  const events: ClaudeActivityEvent[] = [];
  let sessionTitle: string | null = null;
  let earliestMs = wholeFile ? 0 : Number.POSITIVE_INFINITY;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: {
      type?: string;
      aiTitle?: string;
      isSidechain?: boolean;
      userType?: string;
      timestamp?: string;
      uuid?: string;
      cwd?: string;
      gitBranch?: string;
      message?: { content?: unknown };
    };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }

    if (!wholeFile && r.timestamp) {
      const ms = Date.parse(r.timestamp);
      if (Number.isFinite(ms) && ms < earliestMs) earliestMs = ms;
    }

    if (r.type === "ai-title" && r.aiTitle) {
      sessionTitle = r.aiTitle;
      continue;
    }
    if (r.type !== "user" || r.isSidechain || !r.timestamp) continue;
    if (r.userType && r.userType !== "external") continue;

    const text_ = firstText(r.message?.content);
    if (!text_ || isMetaPrompt(text_)) continue;
    const body = oneLine(text_);
    if (!body) continue;

    events.push({
      key: `prompt:${sessionId}:${r.uuid ?? r.timestamp}`,
      kind: "prompt",
      at: r.timestamp,
      body,
      project: r.cwd ? basename(r.cwd) : "unknown",
      branch: r.gitBranch || null,
      sessionTitle: null, // 後で最終タイトルを埋める
    });
  }

  if (!Number.isFinite(earliestMs)) earliestMs = 0;
  for (const e of events) e.sessionTitle = sessionTitle;
  return { events, coveredFromMs: earliestMs };
}

async function eventsForFile(
  path: string,
  fromMs: number,
): Promise<ClaudeActivityEvent[]> {
  let info: { mtimeMs: number; size: number };
  try {
    const s = await stat(path);
    info = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return [];
  }
  if (info.mtimeMs < fromMs) return []; // 期間内に一切書き込みがない

  const cached = cache.get(path);
  if (
    cached &&
    cached.mtimeMs === info.mtimeMs &&
    cached.size === info.size &&
    cached.coveredFromMs <= fromMs
  ) {
    return cached.events.filter((e) => Date.parse(e.at) >= fromMs);
  }

  const sessionId = basename(path, ".jsonl");
  let chunk = INITIAL_CHUNK;
  let result: ParseResult;
  for (;;) {
    const { text, wholeFile } = await readChunk(path, info.size, chunk);
    result = parseChunk(text, sessionId, wholeFile);
    if (wholeFile || result.coveredFromMs <= fromMs || chunk >= MAX_CHUNK) break;
    chunk *= 4;
  }

  cache.set(path, { ...result, ...info });
  return result.events.filter((e) => Date.parse(e.at) >= fromMs);
}

export async function fetchClaudePromptEvents(
  fromIso: string,
  toIso?: string,
): Promise<ClaudeActivityEvent[]> {
  const fromMs = Date.parse(fromIso);

  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const files: string[] = [];
  await Promise.all(
    dirs.map(async (dir) => {
      try {
        const names = await readdir(join(PROJECTS_DIR, dir));
        for (const name of names) {
          if (SESSION_FILE_RE.test(name)) {
            files.push(join(PROJECTS_DIR, dir, name));
          }
        }
      } catch {
        // not a directory
      }
    }),
  );

  const events: ClaudeActivityEvent[] = [];
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((path) => eventsForFile(path, fromMs)),
    );
    for (const r of results) events.push(...r);
  }

  return events.filter((e) => !toIso || e.at < toIso);
}
