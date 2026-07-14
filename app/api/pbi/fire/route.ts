import { NextResponse } from "next/server";
import type { PbiJob } from "@/lib/pbi/types";
import { callRunner } from "@/lib/runner/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function POST(request: Request) {
  let body: { repo?: unknown; issueNumber?: unknown; title?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (
    typeof body.repo !== "string" ||
    typeof body.issueNumber !== "number" ||
    typeof body.title !== "string"
  ) {
    return NextResponse.json(
      { ok: false, error: "repo (string), issueNumber (number) and title (string) are required" },
      { status: 400 },
    );
  }
  if (!REPO_PATTERN.test(body.repo)) {
    return NextResponse.json(
      { ok: false, error: "repo must be in owner/name format" },
      { status: 400 },
    );
  }
  try {
    const { pbi } = await callRunner<{ pbi: PbiJob }>("pbi.fire", {
      repo: body.repo,
      issueNumber: body.issueNumber,
      title: body.title,
    });
    return NextResponse.json({ ok: true, pbi });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pbi.fire failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
