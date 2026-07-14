import type {
  AgentExecutor,
  ExecutorHooks,
  ExecutorResult,
  ExecutorRunOpts,
} from "./executor";

// docs/permission-philosophy.md 移行パス step 3 / PoC #56 (docs/herdr-cli-poc.md) の
// 採用構成をコード化した executor。SdkExecutor と並ぶ AgentExecutor 実装で、実装ジョブを
// herdr ペイン内の interactive な Claude Code CLI セッションとして実行する。
//
// 垂直スライス (#58) の責務に絞る:
//   spawn → session_id 取得 → activity 観測 → 完了検知 (agent_status done) → 結果。
// escalation (層 4 の Notification hook → cockpit) の配線は別 Issue。本スライスでは
// 許可待ちは人間がペインで直接応答する前提のため hooks.requestInput は使わない。
//
// herdr CLI 呼び出し (HerdrClient) と transcript 読み (TranscriptReader) は注入して
// fake 化できるようにしている (テスト可能性 + 実端末タイミングの調整を実装側に閉じる)。

/** herdr CLI の薄いラッパ。実装は RealHerdrClient、テストは fake。 */
export interface HerdrClient {
  /** ワークスペースに新タブを作り、その root ペイン ID を返す。 */
  createPane(opts: { workspaceId: string; label: string }): Promise<string>;
  /**
   * ペイン内で worktree を cwd に interactive な claude を起動し、プロンプトを投入する。
   * 実端末のタイミング (TUI 起動待ち→send-text→Enter) は実装側に閉じる。
   */
  startAgent(
    paneId: string,
    opts: {
      cwd: string;
      prompt: string;
      resumeSessionId: string | null;
      githubToken: string | null;
    },
  ): Promise<void>;
  /** agent_status が done になるまで待つ。timeout したら false。 */
  waitDone(paneId: string, timeoutMs: number): Promise<boolean>;
  /** ペインを閉じて子セッションを終了する (abort・後片付け)。 */
  closePane(paneId: string): Promise<void>;
}

/** transcript (~/.claude/projects/<enc>/<session_id>.jsonl) の探索と活動抽出。 */
export interface TranscriptReader {
  /**
   * cwd に対応する、sinceMs より後に現れた transcript を待つ。
   * 見つかったら絶対パスと session_id を返す。timeout したら null。
   */
  waitForSession(
    cwd: string,
    sinceMs: number,
    timeoutMs: number,
  ): Promise<{ path: string; sessionId: string } | null>;
  /**
   * transcript を fromOffset バイト以降だけ読み、抽出済み activity 文字列と次の
   * 読み取り開始バイトを返す。ポーリングで繰り返し呼ばれるため、追記分のみを読む
   * (全再読の O(n^2) を避ける)。追記途中の不完全な最終行は消費せず nextOffset に
   * 含めない (次回読み直す)。
   */
  readActivitySince(
    path: string,
    fromOffset: number,
  ): Promise<{ activities: string[]; nextOffset: number }>;
}

export type HerdrExecutorDeps = {
  herdr: HerdrClient;
  transcript: TranscriptReader;
  /** worktree を事前 trust する (hasTrustDialogAccepted)。CLI の untrusted 無視を避ける。 */
  trustWorktree(cwd: string): Promise<void>;
  /** タブを作る herdr ワークスペース ID。 */
  workspaceId: string;
  /** 現在時刻 (ms)。テスト注入用。既定は Date.now。 */
  now?: () => number;
  /** activity ポーリング間隔 (ms)。既定 1000。 */
  pollIntervalMs?: number;
  /** session_id 出現を待つ上限 (ms)。既定 30000。 */
  sessionTimeoutMs?: number;
  /** 完了 (agent_status done) を待つ上限 (ms)。既定 30 分。 */
  doneTimeoutMs?: number;
};

// transcript の 1 行 (assistant メッセージ) から activity 文字列を 1 つ取り出す。
// SdkExecutor.extractAssistantText と同じ割り切り: text は先頭 200 字、tool_use は名前。
// thinking / その他は活動として出さない (null)。呼び出し側 (TranscriptReader 実装) が使う。
export function extractActivity(line: unknown): string | null {
  if (typeof line !== "object" || line === null) return null;
  const rec = line as Record<string, unknown>;
  if (rec.type !== "assistant") return null;
  const message = rec.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      return b.text.slice(0, 200);
    }
    if (b.type === "tool_use" && typeof b.name === "string") {
      return `tool: ${b.name}`;
    }
  }
  return null;
}

export class HerdrExecutor implements AgentExecutor {
  constructor(private readonly deps: HerdrExecutorDeps) {}

  async run(
    opts: ExecutorRunOpts,
    hooks: ExecutorHooks,
  ): Promise<ExecutorResult> {
    const now = this.deps.now ?? (() => Date.now());
    const pollIntervalMs = this.deps.pollIntervalMs ?? 1000;
    const sessionTimeoutMs = this.deps.sessionTimeoutMs ?? 30_000;
    const doneTimeoutMs = this.deps.doneTimeoutMs ?? 30 * 60_000;

    let paneId: string | null = null;
    let closed = false;
    // ペインは高々一度だけ閉じる (abort リスナと finally の二重 close を防ぐ)。
    const closeOnce = async () => {
      if (closed || !paneId) return;
      closed = true;
      await this.deps.herdr.closePane(paneId).catch(() => {});
    };
    // 失敗・timeout 時はペインを残して人間が調査できるようにする (dogfood 前提)。
    // 成功・abort 時のみ閉じる。closePane 呼び出し済みなら二度目は no-op。
    let outcome: "success" | "keep" = "success";

    try {
      await this.deps.trustWorktree(opts.cwd);

      const startedAt = now();
      paneId = await this.deps.herdr.createPane({
        workspaceId: this.deps.workspaceId,
        label: `job-${startedAt}`,
      });

      const onAbort = () => {
        void closeOnce();
      };
      if (opts.signal.aborted) {
        await closeOnce();
        return { ok: false, error: "aborted before start" };
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });

      try {
        await this.deps.herdr.startAgent(paneId, {
          cwd: opts.cwd,
          prompt: opts.prompt,
          resumeSessionId: opts.resumeSessionId,
          githubToken: opts.githubToken,
        });

        // session_id が現れるまで待つ (transcript 出現 = セッション開始)。
        const session = await this.deps.transcript.waitForSession(
          opts.cwd,
          startedAt,
          sessionTimeoutMs,
        );
        if (!session) {
          outcome = "keep";
          return { ok: false, error: "session transcript did not appear" };
        }
        hooks.onSessionId(session.sessionId);

        // resume 時、transcript には前回までの履歴が既に入っている。オフセットを
        // 末尾まで進めて履歴を activity として再生しない (今回の追記分だけ流す)。
        let offset = 0;
        if (opts.resumeSessionId) {
          const primed = await this.deps.transcript.readActivitySince(
            session.path,
            0,
          );
          offset = primed.nextOffset;
        }

        // 完了検知と activity ポーリングを並行させる。waitDone が resolve でも
        // reject でも done を確定させ、while ループが確実に抜けるようにする
        // (reject を握りつぶさず後段の await donePromise で顕在化させる)。
        const donePromise = this.deps.herdr.waitDone(paneId, doneTimeoutMs);
        let done = false;
        donePromise.then(
          () => {
            done = true;
          },
          () => {
            done = true;
          },
        );

        while (!done) {
          if (opts.signal.aborted) {
            await closeOnce();
            return { ok: false, error: "aborted" };
          }
          const { activities, nextOffset } =
            await this.deps.transcript.readActivitySince(session.path, offset);
          for (const a of activities) hooks.onActivity(a);
          offset = nextOffset;
          await sleep(pollIntervalMs);
        }

        // reject ならここで throw して外側 catch が実エラーとして返す。
        const ok = await donePromise;
        // done 後に残った activity を最後まで吸い上げる。
        const tail = await this.deps.transcript.readActivitySince(
          session.path,
          offset,
        );
        for (const a of tail.activities) hooks.onActivity(a);

        if (opts.signal.aborted) {
          await closeOnce();
          return { ok: false, error: "aborted" };
        }
        if (ok) return { ok: true };
        outcome = "keep";
        return { ok: false, error: "agent did not reach done before timeout" };
      } finally {
        opts.signal.removeEventListener("abort", onAbort);
      }
    } catch (err) {
      outcome = "keep"; // 実エラーはペインを残して調査可能にする
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // 成功時のみペインを閉じる。失敗・timeout・実エラーは調査のため残す
      // (abort パスは既に closeOnce 済み)。
      if (outcome === "success") await closeOnce();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
