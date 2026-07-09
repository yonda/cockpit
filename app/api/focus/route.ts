import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { focusHerdrTarget } from "@/lib/herdr/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

// ブラウザとサーバーが同じ Mac にいる前提の機能:
// herdr の workspace/tab をフォーカスし、WezTerm を前面に出す。
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const { workspaceId, tabId } = (body ?? {}) as {
    workspaceId?: unknown;
    tabId?: unknown;
  };
  if (typeof workspaceId !== "string" || workspaceId === "") {
    return NextResponse.json(
      { ok: false, error: "workspaceId is required" },
      { status: 400 },
    );
  }
  if (tabId !== undefined && typeof tabId !== "string") {
    return NextResponse.json(
      { ok: false, error: "tabId must be a string" },
      { status: 400 },
    );
  }

  try {
    await focusHerdrTarget(workspaceId, tabId);
    await execFileAsync("open", ["-a", "WezTerm"]);
    console.log(`[focus] ok workspace=${workspaceId} tab=${tabId ?? "-"}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to focus herdr target";
    console.error(`[focus] error workspace=${workspaceId}: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
