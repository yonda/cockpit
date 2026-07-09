import { format, isSameDay } from "date-fns";
import { ja } from "date-fns/locale";

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (isSameDay(d, now)) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (isSameDay(d, y)) return "Yesterday";
  return format(d, "M/d (EEE)", { locale: ja });
}

export function groupByDay<T extends { at: string }>(items: T[]): Array<{ label: string; items: T[] }> {
  const buckets = new Map<string, { label: string; items: T[] }>();
  for (const item of items) {
    const d = new Date(item.at);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { label: dayLabel(item.at), items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(item);
  }
  return Array.from(buckets.values());
}
