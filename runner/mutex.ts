/**
 * キー単位で非同期処理を直列化するユーティリティ。
 *
 * 同一キーに対する runExclusive は呼び出し順（FIFO）で 1 本ずつ実行され、
 * 異なるキー同士は互いにブロックせず並行実行される。
 * fn が throw / reject してもロックは解放され、後続の処理は実行される。
 */
export class KeyedMutex {
  /** キーごとの「最後尾の処理の完了」を表す Promise */
  private tails = new Map<string, Promise<void>>();

  /**
   * key に対するロックを取得して fn を実行する。
   * 戻り値は fn の解決値をそのまま返し、fn のエラーはそのまま伝播する。
   */
  async runExclusive<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 自分を最後尾として登録してから前の処理の完了を待つ（FIFO を保証）
    this.tails.set(key, current);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      // 自分が最後尾のままなら待機者はいないので Map から掃除する
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    }
  }
}
