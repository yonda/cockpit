import { NextResponse } from "next/server";
import { listProgressFiles } from "@/lib/runs/list";
import { selectWakeTargets } from "@/lib/runs/wake";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * wake 機構(#168)の対象一覧を返す。launchd の bin/monitor-wake がこれを叩き、
 * phase:monitoring の run を「生きていれば つつく／死んでいたら 立て直す」。
 *
 * Next プロセスは child_process を使えない(Turbopack 制約 / calendar-sync と同じ理由)ため、
 * ここは列挙・選抜(lib/runs の list 層 + wake 層の再利用)までに徹し、
 * 生死判定や つつき/立て直しといった副作用は外部の executor に委ねる。
 */
export function GET() {
  const { files, skipped } = listProgressFiles();
  return NextResponse.json({
    targets: selectWakeTargets(files),
    skipped,
  });
}
