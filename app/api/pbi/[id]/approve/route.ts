import { NextResponse } from "next/server";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await callRunner("pbi.approve", { pbiId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pbi.approve failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
