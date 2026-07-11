"use client";

import { useSyncExternalStore } from "react";

/**
 * useNow — 1 分ごと（既定）に現在時刻(ms)を返す client 用共有 hook。
 *
 * 多数のカードが同時に購読してもタイマーが乱立しないよう、intervalMs ごとに
 * module レベルの単一 ticker を共有する。購読者が全ていなくなると interval を
 * 停止し、リークを防ぐ。SSR 時はブラウザ API を触らず初期値を返す。
 */

export const DEFAULT_NOW_INTERVAL_MS = 60_000;

/** SSR / hydration 時に返す安定値。process ごとに一度だけ確定させ、
 *  getServerSnapshot が常に同じ値を返すようにする。 */
const INITIAL_NOW = Date.now();

type Ticker = {
  /** この ticker を購読しているコールバック集合 */
  readonly subscribers: Set<() => void>;
  /** 単一の setInterval ハンドル（停止中は null） */
  intervalId: ReturnType<typeof setInterval> | null;
  /** 直近の tick で確定した現在時刻(ms) */
  now: number;
  /** intervalMs ごとに固定の subscribe（React が再購読しないよう identity を安定させる） */
  readonly subscribe: (onStoreChange: () => void) => () => void;
  /** intervalMs ごとに固定の getSnapshot */
  readonly getSnapshot: () => number;
};

/** intervalMs -> Ticker。同じ intervalMs の購読者は 1 本の interval を共有する。 */
const tickers = new Map<number, Ticker>();

function getTicker(intervalMs: number): Ticker {
  const existing = tickers.get(intervalMs);
  if (existing) return existing;

  const created: Ticker = {
    subscribers: new Set(),
    intervalId: null,
    now: INITIAL_NOW,
    subscribe(onStoreChange: () => void): () => void {
      created.subscribers.add(onStoreChange);

      // 最初の購読者が来たら interval を開始する（＝常に 1 本だけ生成）。
      if (created.intervalId === null) {
        created.now = Date.now();
        created.intervalId = setInterval(() => {
          created.now = Date.now();
          for (const notify of created.subscribers) notify();
        }, intervalMs);
      }

      return () => {
        created.subscribers.delete(onStoreChange);
        // 購読者が全ていなくなったら interval を止めてリークを防ぐ。
        if (created.subscribers.size === 0 && created.intervalId !== null) {
          clearInterval(created.intervalId);
          created.intervalId = null;
        }
      };
    },
    getSnapshot(): number {
      return created.now;
    },
  };

  tickers.set(intervalMs, created);
  return created;
}

function getServerSnapshot(): number {
  return INITIAL_NOW;
}

/**
 * 現在時刻(ms)を返し、intervalMs（既定 60000ms）ごとに更新して再レンダーを起こす。
 *
 * @param intervalMs 更新間隔(ms)。同じ値を渡した購読者どうしは 1 本の
 *   setInterval を共有する。既定は {@link DEFAULT_NOW_INTERVAL_MS}。
 * @returns 現在時刻の epoch ミリ秒。`new Date(useNow())` で Date 化できる。
 */
export function useNow(intervalMs: number = DEFAULT_NOW_INTERVAL_MS): number {
  const ticker = getTicker(intervalMs);
  return useSyncExternalStore(
    ticker.subscribe,
    ticker.getSnapshot,
    getServerSnapshot,
  );
}
