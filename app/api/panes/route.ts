import { NextResponse } from "next/server";
import { fetchHerdrState } from "@/lib/herdr/server";
import { readSessionRecap } from "@/lib/claude/recap";
import { readSessionSubagents, summarizeSubagents } from "@/lib/claude/subagents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const state = await fetchHerdrState();
    await Promise.all(
      state.panes.map(async (pane) => {
        if (!pane.sessionId) return;
        const cwds = [pane.foregroundCwd, pane.cwd].filter(
          (d): d is string => Boolean(d),
        );
        const [recap, subagents] = await Promise.all([
          readSessionRecap(pane.sessionId, cwds),
          readSessionSubagents(pane.sessionId, cwds),
        ]);
        pane.recap = recap;
        pane.subagents = recap ? summarizeSubagents(subagents) : null;
      }),
    );
    return NextResponse.json({ ok: true, state });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to reach herdr socket";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
