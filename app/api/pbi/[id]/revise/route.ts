import { NextResponse } from "next/server";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { feedback?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (typeof body.feedback !== "string" || body.feedback.trim() === "") {
    return NextResponse.json({ ok: false, error: "feedback (string) is required" }, { status: 400 });
  }
  try {
    await callRunner("pbi.revise", { pbiId: id, feedback: body.feedback });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pbi.revise failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
