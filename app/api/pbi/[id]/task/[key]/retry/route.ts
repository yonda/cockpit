import { NextResponse } from "next/server";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  const { id, key } = await params;
  try {
    await callRunner("pbi.retryTask", { pbiId: id, key });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pbi.retryTask failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
