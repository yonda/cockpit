"use client";

import { useEffect, useState } from "react";

/**
 * 現在時刻 (Date.now() のエポックミリ秒) を返し、`intervalMs` ごとに更新する共通 hook。
 *
 * - 呼び出しごとにタイマーは1本のみ (setInterval 1本)。
 * - `intervalMs` が変わると古いタイマーを片付けて張り直す。
 * - アンマウント時 / 依存更新時に clearInterval してリークを防ぐ。
 *
 * @param intervalMs 更新間隔 (ミリ秒)。既定は 60000 (1分)。
 * @returns 現在時刻のエポックミリ秒 (number)。
 */
export function useNow(intervalMs = 60000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
