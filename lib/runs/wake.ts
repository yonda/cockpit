import type { ProgressFile, ProgressSession } from "./progress";

/**
 * cockpit の wake 機構(#168)の純ロジック層。
 * 進捗ファイル一覧から「今 wake すべき run(＝phase:monitoring)」を選び、
 * 外部の executor(bin/monitor-wake)が つつく／立て直す ために必要な最小情報に落とす。
 *
 * 生死判定(agmsg ready sentinel の有無)や実際の つつき(agmsg send)・立て直し
 * (herdr agent start)は副作用なので、この層には持たせない(launchd 側 executor の仕事)。
 * ここは「どの run を対象にするか」を GitHub 権威に触れず決めるだけ。
 *
 * done になった run は phase!=="monitoring" で自然に脱落する(＝wake が止まる)。
 */

export type WakeTarget = {
  repo: string;
  issueNumber: number;
  title: string;
  /** repo と issueNumber から導出した issue の GitHub URL(立て直し時の /issue-driver 引数) */
  issueUrl: string;
  /** 担当セッションの連絡先。未記録なら null(executor は立て直し側に倒す) */
  session: ProgressSession | null;
};

function issueUrl(repo: string, issueNumber: number): string {
  return `https://github.com/${repo}/issues/${issueNumber}`;
}

/**
 * 進捗ファイル一覧から wake 対象(phase:monitoring)を抽出する。
 * 入力順を保つ。
 */
export function selectWakeTargets(files: ProgressFile[]): WakeTarget[] {
  return files
    .filter((f) => f.phase === "monitoring")
    .map((f) => ({
      repo: f.repo,
      issueNumber: f.issueNumber,
      title: f.title,
      issueUrl: issueUrl(f.repo, f.issueNumber),
      session: f.session,
    }));
}
