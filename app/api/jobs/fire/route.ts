import { NextResponse } from "next/server";
import { LAUNCH_REPO, type Job } from "@/lib/jobs/types";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { issueNumber?: unknown; issueTitle?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (typeof body.issueNumber !== "number" || typeof body.issueTitle !== "string") {
    return NextResponse.json(
      { ok: false, error: "issueNumber (number) and issueTitle (string) are required" },
      { status: 400 },
    );
  }
  try {
    const { job } = await callRunner<{ job: Job }>("job.fire", {
      repo: LAUNCH_REPO,
      issueNumber: body.issueNumber,
      issueTitle: body.issueTitle,
    });
    console.log(`[launch] fired issue #${body.issueNumber} -> ${job.id}`);
    return NextResponse.json({ ok: true, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : "fire failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
