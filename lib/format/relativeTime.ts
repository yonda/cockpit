import { formatDistanceToNowStrict } from "date-fns";
import { ja } from "date-fns/locale";

export function relativeTime(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), {
    addSuffix: true,
    locale: ja,
  });
}

/**
 * relativeTimeShort — "just now" / "3m ago" / "2h ago" / "5d ago" 形式の英語短縮版。
 *
 * これまで PaneCard / JobCard が各々ローカルに持っていた（両者同一の）関数を集約したもの。
 * 出力テキストは従来と一字一句同じ。`now` を差し替え可能にしてあり、既定では
 * 呼び出し時点の {@link Date.now} を用いるため、引数 1 個での呼び出しは従来と等価。
 *
 * @param iso 対象時刻の ISO 文字列
 * @param now 基準となる現在時刻(epoch ms)。既定は `Date.now()`。
 */
export function relativeTimeShort(iso: string, now: number = Date.now()): string {
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
