import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  fetchTodaySchedule as fetchFromGoogle,
  isCalendarConfigured as isGoogleConfigured,
  type TodaySchedule,
} from "@/lib/google/calendar";

const CACHE_FILE = join(homedir(), ".cache", "cockpit", "calendar-today.json");

export type ScheduleResult = TodaySchedule & {
  source: "google-api" | "icalbuddy-cache";
};

// Google OAuth が設定されていれば API 直、なければ launchd
// (com.cockpit.calendar) が icalBuddy で書き出すキャッシュを読む。
// どちらも無ければ null (未設定表示)。
export async function fetchSchedule(): Promise<ScheduleResult | null> {
  if (isGoogleConfigured()) {
    const schedule = await fetchFromGoogle();
    return { ...schedule, source: "google-api" };
  }

  let raw: string;
  try {
    raw = await readFile(CACHE_FILE, "utf8");
  } catch {
    return null; // キャッシュ未生成 = セットアップ前
  }

  const parsed = JSON.parse(raw) as TodaySchedule;
  // 日付をまたいだ古いキャッシュは空扱い (launchd が止まっている等)
  const fetchedDay = parsed.fetchedAt?.slice(0, 10);
  const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD (local)
  if (fetchedDay !== today) {
    return { events: [], fetchedAt: parsed.fetchedAt, source: "icalbuddy-cache" };
  }
  return { ...parsed, source: "icalbuddy-cache" };
}
