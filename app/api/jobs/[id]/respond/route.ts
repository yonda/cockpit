import { NextResponse } from "next/server";
import { isPendingInputResponse } from "@/lib/jobs/types";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { inputId?: unknown; response?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (typeof body.inputId !== "string" || !isPendingInputResponse(body.response)) {
    return NextResponse.json(
      { ok: false, error: "inputId and a valid response are required" },
      { status: 400 },
    );
  }
  try {
    await callRunner("job.respond", {
      jobId: id,
      inputId: body.inputId,
      response: body.response,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "respond failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
