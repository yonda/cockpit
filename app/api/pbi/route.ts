import { NextResponse } from "next/server";
import type { PbiJob } from "@/lib/pbi/types";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { pbis } = await callRunner<{ pbis: PbiJob[] }>("pbi.list", {});
    return NextResponse.json({ ok: true, pbis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pbi.list failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
