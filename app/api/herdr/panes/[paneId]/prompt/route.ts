import { NextResponse } from "next/server";
import { sendHerdrPrompt } from "@/lib/herdr/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_TEXT_LENGTH = 4_000;

// ブラウザから pane にテキストを送って Enter を押す。
// 相手が agent なら prompt になり、shell ならコマンド実行になる。
export async function POST(
  request: Request,
  { params }: { params: Promise<{ paneId: string }> },
) {
  const { paneId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const { text } = (body ?? {}) as { text?: unknown };
  if (typeof text !== "string" || text.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "text is required" },
      { status: 400 },
    );
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { ok: false, error: `text must be at most ${MAX_TEXT_LENGTH} characters` },
      { status: 400 },
    );
  }

  try {
    await sendHerdrPrompt(paneId, text);
    console.log(`[herdr] prompt ok pane=${paneId} chars=${text.length}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to send prompt";
    console.error(`[herdr] prompt error pane=${paneId}: ${message}`);
    const status = /not found/i.test(message) ? 404 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
