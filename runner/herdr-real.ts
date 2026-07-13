import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  extractActivity,
  type HerdrClient,
  type TranscriptReader,
} from "./herdr-executor";

const execFileAsync = promisify(execFile);

// HerdrExecutor の本番用 Real 実装。herdr CLI と ~/.claude 配下のファイルを実際に叩く。
// orchestration (HerdrExecutor) は herdr-executor.test.ts で fake により検証済み。
// ここは実端末・実 FS への依存が強く、最終的な挙動は dogfood (#58 受け入れ確認) で
// 調整する。特に startAgent の TUI 起動待ちは端末タイミング依存のため要チューニング点。

async function herdr(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, {
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  return stdout;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class RealHerdrClient implements HerdrClient {
  async createPane(opts: {
    workspaceId: string;
    label: string;
  }): Promise<string> {
    const out = await herdr([
      "tab",
      "create",
      "--workspace",
      opts.workspaceId,
      "--label",
      opts.label,
      "--no-focus",
    ]);
    const paneId = JSON.parse(out)?.result?.root_pane?.pane_id;
    if (typeof paneId !== "string") {
      throw new Error(`herdr tab create から pane_id を取得できません: ${out}`);
    }
    return paneId;
  }

  async startAgent(
    paneId: string,
    opts: {
      cwd: string;
      settingsPath: string;
      prompt: string;
      resumeSessionId: string | null;
    },
  ): Promise<void> {
    const resumeFlag = opts.resumeSessionId
      ? ` --resume ${shellQuote(opts.resumeSessionId)}`
      : "";
    const launch = `cd ${shellQuote(opts.cwd)} && claude --settings ${shellQuote(
      opts.settingsPath,
    )}${resumeFlag}`;
    await herdr(["pane", "run", paneId, launch]);

    // interactive な TUI が起動するのを待つ。footer の文言はバージョン差があるため
    // 複数候補を regex で待ち、駄目でも固定待ちにフォールバックする (dogfood 調整点)。
    try {
      await herdr([
        "wait",
        "output",
        paneId,
        "--match",
        "shortcuts|accept edits|Bypassing|for agents",
        "--regex",
        "--timeout",
        "15000",
      ]);
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }

    // プロンプトを送信して Enter。send-text で本文、send-keys で改行送出。
    await herdr(["pane", "send-text", paneId, opts.prompt]);
    await herdr(["pane", "send-keys", paneId, "Enter"]);
  }

  async waitDone(paneId: string, timeoutMs: number): Promise<boolean> {
    try {
      await herdr([
        "wait",
        "agent-status",
        paneId,
        "--status",
        "done",
        "--timeout",
        String(timeoutMs),
      ]);
      return true;
    } catch {
      return false; // timeout (exit 1)
    }
  }

  async closePane(paneId: string): Promise<void> {
    await herdr(["pane", "close", paneId]);
  }
}

// cwd → ~/.claude/projects/<encoded> のディレクトリ名。非英数字を "-" に置換する
// (実測: "/Users/alice/..." → "-Users-alice-..."、"a.b" → "a-b")。
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export class RealTranscriptReader implements TranscriptReader {
  constructor(
    private readonly projectsRoot: string = path.join(
      os.homedir(),
      ".claude",
      "projects",
    ),
  ) {}

  async waitForSession(
    cwd: string,
    sinceMs: number,
    timeoutMs: number,
  ): Promise<{ path: string; sessionId: string } | null> {
    const dir = path.join(this.projectsRoot, encodeProjectDir(cwd));
    const deadline = sinceMs + timeoutMs;
    // sinceMs 起点で mtime を判定すると、直前の実行の transcript を掴む恐れがある。
    // startAgent 後に新しく作られた jsonl (birthtime/mtime > sinceMs) の最新を選ぶ。
    for (;;) {
      const found = this.newestSince(dir, sinceMs);
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private newestSince(
    dir: string,
    sinceMs: number,
  ): { path: string; sessionId: string } | null {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return null; // ディレクトリ未作成
    }
    let best: { path: string; sessionId: string; mtime: number } | null = null;
    for (const f of entries) {
      const p = path.join(dir, f);
      let mtime: number;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < sinceMs) continue;
      if (!best || mtime > best.mtime) {
        best = { path: p, sessionId: f.replace(/\.jsonl$/, ""), mtime };
      }
    }
    return best ? { path: best.path, sessionId: best.sessionId } : null;
  }

  async readActivitySince(
    filePath: string,
    fromLine: number,
  ): Promise<{ activities: string[]; nextLine: number }> {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return { activities: [], nextLine: fromLine };
    }
    // 末尾が改行のとき split で末尾に空要素が出るので落とす。
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const activities: string[] = [];
    // append-only JSONL では最終行だけが書き込み途中で JSON 不完全になり得る。
    // その行を lines.length へ進めて確定扱いすると二度と読み直さないため、
    // パース失敗した最終行は nextLine を進めず次回に持ち越す。
    let nextLine = lines.length;
    for (let i = fromLine; i < lines.length; i++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        if (i === lines.length - 1) {
          nextLine = i; // 追記途中の最終行: 次回読み直す
          break;
        }
        continue; // 中間の壊れた行はスキップ (通常発生しない)
      }
      const a = extractActivity(parsed);
      if (a) activities.push(a);
    }
    return { activities, nextLine };
  }
}
