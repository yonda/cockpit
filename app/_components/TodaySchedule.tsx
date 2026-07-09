import { fetchSchedule } from "@/lib/calendar/today";
import { SectionErrorState } from "./ErrorState";
import { TodayTimeline } from "./TodayTimeline";

export async function TodaySchedule() {
  let schedule;
  try {
    schedule = await fetchSchedule();
  } catch (err) {
    return <SectionErrorState error={err} />;
  }

  if (!schedule) {
    return (
      <div className="border border-dashed border-[var(--hairline)] px-6 py-4 font-mono text-[12px] text-[var(--ink-muted)]">
        calendar not configured — install the calendar-sync launchd agent or
        run <code className="text-[var(--ink-dim)]">bin/google-auth</code>
      </div>
    );
  }

  return (
    <TodayTimeline
      events={schedule.events}
      fetchedAt={schedule.fetchedAt}
      showSyncedAt={schedule.source === "icalbuddy-cache"}
    />
  );
}
