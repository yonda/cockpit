"use client";

import { useCallback, useRef, useState } from "react";

/**
 * useInFlightAction — POST 系ハンドラの二重発火を閉じる共通フック。
 *
 * React の setState は非同期のため、同一レンダーサイクル内で連打すると 2 クリック目が
 * クロージャに閉じ込められた古い busy=false を見てガードを素通りし、POST が二重に飛ぶ
 * 競合窓が生まれる。これを、同期的に読み書きできる useRef の in-flight フラグで閉じる。
 *
 * `run` は先頭で {@link inFlightRef} を同期チェック・同期セットするため、同一フレーム内の
 * 2 連クリックでも `action`（＝ fetch(POST)）は 1 回しか実行されない。表示用の busy state
 * は別に持ち、disabled 属性やボタン文言の切り替えに使う。
 *
 * `action` は成功で `true` / 失敗で `false` を返す。既定では成功・失敗いずれでもガードを
 * 解除して再操作可能にする。`keepInFlightOnSuccess: true` を渡すと成功時のみガードを維持し
 * （＝ボタンを押せないまま保つ）、失敗時のみ解除する。
 *
 * @template T busy state に載せるトークンの型。既定は真偽値相当（`true` / `null`）。
 *   どのボタンが発射中かを識別したい場合は issue key 等を `T` に指定して `run(action, token)`
 *   で渡す（例: `useInFlightAction<string>()`）。
 */

export type UseInFlightActionOptions = {
  /**
   * 成功時（action が true を返した時）にガードを維持するか。
   * true なら成功後も inFlightRef / busy を解除しない。既定 false（成功時も解除）。
   * 失敗時は本オプションに関わらず常に解除する。
   */
  keepInFlightOnSuccess?: boolean;
};

export type UseInFlightAction<T> = {
  /** busy 中のトークン（未実行時は null）。トークン識別が要らなければ `isBusy` を使う。 */
  readonly busy: T | null;
  /** busy かどうかの真偽値。`disabled={isBusy}` 等に使う。 */
  readonly isBusy: boolean;
  /**
   * `action` を in-flight ガード付きで実行する。既に実行中なら即 return し何もしない。
   * @param action 成功で true / 失敗で false を返す非同期処理（fetch など）。
   * @param token busy state に載せる識別子。省略時は `true` 相当。
   */
  readonly run: (action: () => Promise<boolean>, token?: T) => Promise<void>;
  /**
   * ガードを外部から手動解除する。`keepInFlightOnSuccess: true` で成功後もガードを
   * 保持しているとき、ポーリングで状態変化を検知した呼び出し側が再有効化するために使う。
   * `action` を await 中（fetch 実行中）は何もしない — 発射中の二重発火窓を再び開かないため。
   */
  readonly reset: () => void;
};

export function useInFlightAction<T = true>(
  options: UseInFlightActionOptions = {},
): UseInFlightAction<T> {
  const { keepInFlightOnSuccess = false } = options;
  // 同期ガード：レンダーをまたがず即座に読み書きでき、連打の競合窓を閉じる。
  const inFlightRef = useRef(false);
  // action（＝ fetch）を await している最中だけ true。reset がこの窓で解除して
  // 発射中の二重発火窓を開いてしまうのを防ぐためのフラグ。
  const runningRef = useRef(false);
  // 表示用：disabled やボタン文言の切り替えに使う（更新は非同期でよい）。
  const [busy, setBusy] = useState<T | null>(null);

  const run = useCallback(
    async (action: () => Promise<boolean>, token: T = true as T): Promise<void> => {
      // 先頭で同期チェック・同期セット。ここを通れるのは同一フレームで最初の 1 回だけ。
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      runningRef.current = true;
      setBusy(token);

      let ok = false;
      try {
        ok = await action();
      } finally {
        runningRef.current = false;
        // 失敗時は常に解除。成功時は keepInFlightOnSuccess=false のときだけ解除する。
        if (!ok || !keepInFlightOnSuccess) {
          inFlightRef.current = false;
          setBusy(null);
        }
      }
    },
    [keepInFlightOnSuccess],
  );

  const reset = useCallback(() => {
    // fetch 実行中の解除は二重発火窓を開くので無視。成功後の保持状態のみ解除する。
    if (runningRef.current) return;
    inFlightRef.current = false;
    setBusy(null);
  }, []);

  return { busy, isBusy: busy !== null, run, reset };
}
