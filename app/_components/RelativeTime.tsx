"use client";

import { relativeTime, relativeTimeShort } from "@/lib/format/relativeTime";
import { useNow } from "./useNow";

/**
 * RelativeTime — iso 文字列を受け取り相対時刻を表示する client presentational コンポーネント。
 *
 * 内部で {@link useNow} を購読するため、時間経過（既定 1 分ごと）で相対時刻テキストが
 * 再計算・再描画される。これを client 境界として一元化することで、サーバーコンポーネント側
 * （例: PullRequestCard）を client 化せずに自動更新できる。
 *
 * variant で出力を出し分ける:
 *  - "ja"    … date-fns (日本語ロケール)。現行 PullRequestCard 相当。
 *  - "short" … "3m ago" 形式の英語短縮版。現行 PaneCard / JobCard 相当。
 *
 * className を渡せるので、呼び出し側の既存スタイル（font-mono / CSS 変数 / サイズ）を
 * そのまま適用でき、`<span className={...}>{relativeTime(iso)}</span>` のマークアップを維持できる。
 */

export type RelativeTimeVariant = "ja" | "short";

export function RelativeTime({
  iso,
  variant = "ja",
  className,
  intervalMs,
}: {
  /** 対象時刻の ISO 文字列 */
  iso: string;
  /** 出力フォーマット。既定は "ja"（date-fns 日本語版）。 */
  variant?: RelativeTimeVariant;
  /** span に適用する className（既存スタイルをそのまま渡せる） */
  className?: string;
  /** 更新間隔(ms)。未指定なら useNow の既定（60000ms）。 */
  intervalMs?: number;
}) {
  const now = useNow(intervalMs);
  // ja は date-fns が内部で現在時刻を参照するため、再描画さえ起これば最新化される。
  // short は useNow の now を渡し、tick と表示の基準時刻を揃える。
  const text = variant === "short" ? relativeTimeShort(iso, now) : relativeTime(iso);

  return <span className={className}>{text}</span>;
}
