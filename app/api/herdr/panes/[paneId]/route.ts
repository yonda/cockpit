import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse, type NextRequest } from "next/server";
import {
  getHerdrPane,
  paneCwds,
  readHerdrPane,
  type HerdrReadSource,
} from "@/lib/herdr/server";
import { readSessionSubagents, type SubagentInfo } from "@/lib/claude/subagents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const SOURCES: ReadonlySet<string> = new Set<HerdrReadSource>([
  "visible",
  "recent",
  "recent_unwrapped",
]);
const DEFAULT_LINES = 80;
const MAX_LINES = 400;

async function currentBranch(cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 2_000 },
    );
    const branch = stdout.trim();
    return branch === "" ? null : branch;
  } catch {
    // git リポジトリでない、git が無い等。ブランチ無しとして扱う
    return null;
  }
}

// 選択中の pane の詳細: herdr 上の最新情報 + 画面テキスト + git ブランチ。
// Herdr タブの右列が数秒おきに叩く。
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ paneId: string }> },
) {
  const { paneId } = await params;
  const url = request.nextUrl;
  const sourceParam = url.searchParams.get("source") ?? "recent";
  if (!SOURCES.has(sourceParam)) {
    return NextResponse.json(
      { ok: false, error: `unknown source: ${sourceParam}` },
      { status: 400 },
    );
  }
  const source = sourceParam as HerdrReadSource;
  const linesParam = Number(url.searchParams.get("lines") ?? DEFAULT_LINES);
  const lines = Number.isInteger(linesParam)
    ? Math.min(Math.max(linesParam, 1), MAX_LINES)
    : DEFAULT_LINES;

  try {
    // pane.get は git 用の生 cwd を得るためだけに呼ぶ。pane.read と並列に流す
    const [{ pane, rawCwd }, screen] = await Promise.all([
      getHerdrPane(paneId),
      readHerdrPane(paneId, source, lines),
    ]);
    const [branch, subagents] = await Promise.all([
      currentBranch(rawCwd),
      pane.sessionId
        ? readSessionSubagents(pane.sessionId, paneCwds(pane))
        : Promise.resolve<SubagentInfo[]>([]),
    ]);
    return NextResponse.json({
      ok: true,
      branch,
      subagents,
      screen: { ...screen, source, lines },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to read herdr pane";
    const status = /not found/i.test(message) ? 404 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
