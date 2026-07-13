import type { Job, JobStatus } from "@/lib/jobs/types";
import type { HerdrPane } from "@/lib/herdr/types";

// runner がまだ駆動しているジョブの状態。終端 (done/failed/cancelled) のジョブは
// もう駆動されておらず、そのペインが残っていても「要判断のジョブ」ではないため
// 結合対象から除外する。
const ACTIVE_JOB_STATUSES = new Set<JobStatus>([
  "queued",
  "running",
  "waiting_input",
]);

// herdr ペインの blocked/done 遷移を、それが HerdrExecutor ジョブのペインか
// (人間の個人セッションか) で振り分けて通知プランを作る純関数。
//
// 結合キー: pane.sessionId === job.sessionId。herdr の agent_session.value は
// Claude Code の session_id と一致し (実測)、HerdrExecutor は onSessionId で
// job.sessionId に同じ値を保存するため、executor 変更なしにペイン↔ジョブを繋げる。
//
// 役割分担 (二重通知の回避):
//   - ジョブに紐づくペインの blocked → ここで「ジョブ #N が要判断」を通知する
//     (JobNotifyWatcher は job が running のままなので鳴らない = 層4 escalation の本体)。
//   - ジョブに紐づくペインの done → ここでは鳴らさない。ジョブ完了 (PR ready) の
//     通知は JobNotifyWatcher が job.status=done で担うため。
//   - ジョブに紐づかない個人ペイン → 従来どおり blocked/done 両方を汎用通知する。

export type PaneNotifyPlan = {
  title: string;
  body: string;
  sound: "needsYou" | "done";
  icon: string;
  tag: string;
  focus: { workspaceId: string; tabId: string };
} | null;

function paneBody(pane: HerdrPane): string {
  return pane.recap?.title ?? pane.recap?.lastPrompt ?? pane.agent ?? pane.paneId;
}

/**
 * needs-you (blocked|done) に遷移したペインの通知プランを返す。鳴らさないときは null。
 * @param pane 遷移したペイン (agentStatus は blocked か done)
 * @param job pane.sessionId に一致する running ジョブ (無ければ undefined = 個人ペイン)
 * @param workspaceLabel workspaceId 表示名 (個人ペイン用)
 */
export function planPaneNotify(
  pane: HerdrPane,
  job: Job | undefined,
  workspaceLabel: string,
): PaneNotifyPlan {
  const status = pane.agentStatus;
  if (status !== "blocked" && status !== "done") return null;

  const focus = { workspaceId: pane.workspaceId, tabId: pane.tabId };
  const tag = `cockpit:agent:${pane.paneId}:${status}`;

  if (job) {
    // ジョブ完了通知は JobNotifyWatcher (job.status=done, PR 検証済み) に委ねる。
    // ここでは pane=done を鳴らさない。pane が done でも PR ゲート未通過なら「完了」
    // ではないため、pane=done で「done」と鳴らすのは誤情報になる (完了の真実は
    // job.status)。ワークフローが終端遷移前に死ぬと通知が出ないが、それはジョブが
    // 詰まっている異常であり、ボード側で顕在化する (通知設計側では追わない)。
    if (status === "done") return null;
    return {
      title: `JOB · #${job.issueNumber} — waiting for you`,
      body: job.issueTitle,
      sound: "needsYou",
      icon: "/notify-blocked.png",
      tag,
      focus,
    };
  }

  // 個人ペイン: 従来の汎用通知。
  return {
    title:
      status === "blocked"
        ? `AGENT · ${workspaceLabel} — waiting for you`
        : `AGENT · ${workspaceLabel} — done`,
    body: paneBody(pane),
    sound: status === "blocked" ? "needsYou" : "done",
    icon: status === "blocked" ? "/notify-blocked.png" : "/notify-done.png",
    tag,
    focus,
  };
}

/**
 * active な (runner が駆動中の) ジョブから sessionId → Job のマップを作る。
 * 終端ジョブ (done/failed/cancelled) は除外する: 失敗時にペインを残す運用のため
 * 死んだジョブに紐づき続けると、そのペインでの blocked が誤って「要判断のジョブ」
 * として通知されてしまう。除外により、終端ジョブのペインは個人ペイン扱いになる。
 */
export function buildSessionToJob(jobs: Job[]): Map<string, Job> {
  const map = new Map<string, Job>();
  for (const job of jobs) {
    if (job.sessionId && ACTIVE_JOB_STATUSES.has(job.status)) {
      map.set(job.sessionId, job);
    }
  }
  return map;
}
