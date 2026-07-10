import { NextResponse } from "next/server";
import type { Job } from "@/lib/jobs/types";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { jobs } = await callRunner<{ jobs: Job[] }>("job.list", {});
    return NextResponse.json({ ok: true, jobs });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to reach runner socket";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
