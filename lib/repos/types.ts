// ---- repos.* ソケットプロトコル -------------------------------------------

/** 登録リポに限定した「自分アサインの open issue」の 1 要素。 */
export type AssignedIssue = {
  repo: string; // "owner/name"
  issueNumber: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
};

/**
 * 検索に失敗した owner のエラー印。RPC 全体は成功のまま、この owner の
 * issue だけが結果から欠落していることを呼び出し側に伝える。
 */
export type AssignedIssuesOwnerError = {
  owner: string;
  message: string;
};

/** repos.assignedIssues のレスポンス。 */
export type AssignedIssuesResult = {
  issues: AssignedIssue[];
  errors: AssignedIssuesOwnerError[];
};

export type ReposRunnerRequest = {
  id: string;
  method: "repos.assignedIssues";
  params: Record<string, never>;
};
