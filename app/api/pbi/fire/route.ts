import { NextResponse } from "next/server";
import { LAUNCH_REPO } from "@/lib/jobs/types";
import type { PbiJob } from "@/lib/pbi/types";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { issueNumber?: unknown; title?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (typeof body.issueNumber !== "number" || typeof body.title !== "string") {
    return NextResponse.json(
      { ok: false, error: "issueNumber (number) and title (string) are required" },
      { status: 400 },
    );
  }
  try {
    const { pbi } = await callRunner<{ pbi: PbiJob }>("pbi.fire", {
      repo: LAUNCH_REPO,
      issueNumber: body.issueNumber,
      title: body.title,
    });
    return NextResponse.json({ ok: true, pbi });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pbi.fire failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
