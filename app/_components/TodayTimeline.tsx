"use client";

import { useEffect, useState } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import type { CalendarEvent } from "@/lib/google/calendar";

const WINDOW_START = 7; // 07:00
const WINDOW_END = 21; // 21:00
const HOUR_PX = 44;
const TOTAL_PX = (WINDOW_END - WINDOW_START) * HOUR_PX;

function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function topPx(minutes: number): number {
  return ((minutes - WINDOW_START * 60) / 60) * HOUR_PX;
}

export function TodayTimeline({
  events,
  fetchedAt,
  showSyncedAt,
}: {
  events: CalendarEvent[];
  fetchedAt: string;
  showSyncedAt: boolean;
}) {
  // SSR とのハイドレーション不一致を避けるため、現在時刻依存の描画は
  // マウント後にだけ行う (初回ペイントはニュートラル)
  const [nowMin, setNowMin] = useState<number | null>(null);
  useEffect(() => {
    const update = () =>
      setNowMin(new Date().getHours() * 60 + new Date().getMinutes());
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, []);

  const allDay = events.filter((e) => e.allDay);
  const timed = events.filter((e) => !e.allDay);

  const inWindow = timed.filter(
    (e) =>
      minutesOfDay(e.end) > WINDOW_START * 60 &&
      minutesOfDay(e.start) < WINDOW_END * 60,
  );
  const outOfWindow = timed.filter((e) => !inWindow.includes(e));

  const nowInWindow =
    nowMin !== null && nowMin >= WINDOW_START * 60 && nowMin <= WINDOW_END * 60;

  return (
    <div className="flex flex-col gap-2">
      {showSyncedAt ? (
        <div className="self-end font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-muted)]">
          synced {formatDistanceToNowStrict(new Date(fetchedAt))} ago
        </div>
      ) : null}

      {allDay.map((e) => (
        <div
          key={e.id}
          className="border border-[var(--hairline)] bg-[var(--accent)]/5 px-3 py-1.5 font-mono text-[11px] text-[var(--ink-dim)]"
          title={e.title}
        >
          <span className="mr-2 text-[10px] uppercase tracking-[0.14em] text-[var(--ink-muted)]">
            all day
          </span>
          {e.title}
        </div>
      ))}

      <div className="relative" style={{ height: TOTAL_PX }}>
        {/* 時刻グリッド */}
        {Array.from(
          { length: WINDOW_END - WINDOW_START + 1 },
          (_, i) => WINDOW_START + i,
        ).map((hour) => (
          <div
            key={hour}
            className="absolute left-0 right-0 flex -translate-y-1/2 items-center gap-2"
            style={{ top: topPx(hour * 60) }}
          >
            <span className="w-7 shrink-0 font-mono text-[10px] tabular-nums text-[var(--ink-faint)]">
              {String(hour).padStart(2, "0")}
            </span>
            <div className="h-px flex-1 bg-[var(--hairline)]/60" />
          </div>
        ))}

        {/* 予定ブロック */}
        {inWindow.map((event) => {
          const startMin = Math.max(minutesOfDay(event.start), WINDOW_START * 60);
          const endMin = Math.min(minutesOfDay(event.end), WINDOW_END * 60);
          const top = topPx(startMin);
          const height = Math.max(topPx(endMin) - top, 18);
          const phase =
            nowMin === null
              ? "upcoming"
              : nowMin >= minutesOfDay(event.end)
                ? "past"
                : nowMin >= minutesOfDay(event.start)
                  ? "current"
                  : "upcoming";

          const block = (
            <div
              className={`absolute left-9 right-0 overflow-hidden border-l-2 px-2 py-0.5 ${
                phase === "current"
                  ? "border-[var(--accent)] bg-[var(--accent)]/15"
                  : phase === "past"
                    ? "border-[var(--ink-faint)] bg-[var(--hairline)]/30 opacity-50"
                    : "border-[var(--signal-info)]/70 bg-[var(--signal-info)]/8"
              }`}
              style={{ top, height }}
              title={`${format(new Date(event.start), "HH:mm")} – ${format(new Date(event.end), "HH:mm")} ${event.title}`}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className={`shrink-0 font-mono text-[10px] tabular-nums ${
                    phase === "current"
                      ? "font-semibold text-[var(--accent)]"
                      : "text-[var(--ink-muted)]"
                  }`}
                >
                  {format(new Date(event.start), "HH:mm")}
                </span>
                <span
                  className={`truncate text-[12px] leading-tight ${
                    phase === "current"
                      ? "font-semibold text-[var(--ink)]"
                      : "text-[var(--ink-dim)]"
                  }`}
                >
                  {event.title}
                </span>
              </div>
            </div>
          );

          return event.meetUrl ? (
            <a
              key={event.id}
              href={event.meetUrl}
              target="_blank"
              rel="noreferrer"
              className="contents"
            >
              {block}
            </a>
          ) : (
            <div key={event.id} className="contents">
              {block}
            </div>
          );
        })}

        {/* 現在時刻ライン */}
        {nowInWindow ? (
          <div
            className="absolute left-0 right-0 z-10 flex -translate-y-1/2 items-center gap-1"
            style={{ top: topPx(nowMin) }}
          >
            <span className="w-7 shrink-0 bg-[var(--background)] font-mono text-[10px] font-bold tabular-nums text-[var(--signal-alert)]">
              {String(Math.floor(nowMin / 60)).padStart(2, "0")}:
              {String(nowMin % 60).padStart(2, "0")}
            </span>
            <span className="h-1.5 w-1.5 -translate-x-0.5 rounded-full bg-[var(--signal-alert)]" />
            <div className="h-[2px] flex-1 bg-[var(--signal-alert)]" />
          </div>
        ) : null}
      </div>

      {outOfWindow.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-[var(--hairline)] pt-2">
          {outOfWindow.map((e) => (
            <div
              key={e.id}
              className="truncate font-mono text-[11px] text-[var(--ink-muted)]"
              title={e.title}
            >
              {format(new Date(e.start), "HH:mm")} {e.title}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
