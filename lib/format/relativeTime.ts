import { formatDistanceToNowStrict } from "date-fns";
import { ja } from "date-fns/locale";

export function relativeTime(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), {
    addSuffix: true,
    locale: ja,
  });
}
