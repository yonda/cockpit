import { describe, expect, it } from "vitest";
import type { CommandRunner, RunResult } from "../exec";
import type { SubTask } from "../../lib/pbi/types";
import { RealGitHubClient, subIssueBody } from "../github";

const task: SubTask = {
  key: "t1",
  title: "型を作る",
  goal: "土台",
  deliverable: "types.ts",
  acceptanceCriteria: ["テストが通る", "型エラーがない"],
  dependsOn: [],
};

/** 呼び出しを記録し、コマンドごとに用意した stdout を返すフェイク */
class FakeCommands implements CommandRunner {
  calls: { cmd: string; args: string[] }[] = [];
  responses: (RunResult | ((args: string[]) => RunResult))[] = [];
  async run(cmd: string, args: string[]): Promise<RunResult> {
    this.calls.push({ cmd, args });
    const next = this.responses.shift() ?? { stdout: "", stderr: "" };
    return typeof next === "function" ? next(args) : next;
  }
}

describe("subIssueBody", () => {
  it("includes the marker when proposed and the acceptance criteria", () => {
    const body = subIssueBody(task, true);
    expect(body.startsWith("<!-- cockpit:proposed -->")).toBe(true);
    expect(body).toContain("テストが通る");
  });
  it("omits the marker when confirmed", () => {
    expect(subIssueBody(task, false)).not.toContain("cockpit:proposed");
  });
});

const resolveToken = (owner: string) => `tok-${owner}`;

describe("RealGitHubClient.createSubIssue", () => {
  it("creates the child issue then links it via the sub_issues endpoint", async () => {
    const commands = new FakeCommands();
    // 1) POST /issues -> {id, number, html_url}
    commands.responses.push({
      stdout: JSON.stringify({
        id: 555,
        number: 101,
        html_url: "https://github.com/yonda/cockpit/issues/101",
      }),
      stderr: "",
    });
    // 2) POST /issues/42/sub_issues -> 201 (本文不要)
    commands.responses.push({ stdout: "", stderr: "" });

    const gh = new RealGitHubClient(commands, resolveToken);
    const res = await gh.createSubIssue("yonda/cockpit", 42, task);

    expect(res).toEqual({
      number: 101,
      url: "https://github.com/yonda/cockpit/issues/101",
    });
    // 子 issue 作成
    expect(commands.calls[0].args).toContain(
      "/repos/yonda/cockpit/issues",
    );
    // 親へのリンク: sub_issue_id は number(101) ではなく内部 id(555)
    const linkArgs = commands.calls[1].args.join(" ");
    expect(linkArgs).toContain("/repos/yonda/cockpit/issues/42/sub_issues");
    expect(linkArgs).toContain("sub_issue_id=555");
  });
});

describe("RealGitHubClient.fetchIssue", () => {
  it("fetches issue with title and body", async () => {
    const commands = new FakeCommands();
    commands.responses.push({
      stdout: JSON.stringify({ title: "T", body: "B" }),
      stderr: "",
    });
    const gh = new RealGitHubClient(commands, resolveToken);
    const res = await gh.fetchIssue("yonda/cockpit", 42);
    expect(res).toEqual({ title: "T", body: "B" });
    expect(commands.calls[0].args).toContain("issue");
    expect(commands.calls[0].args).toContain("view");
    expect(commands.calls[0].args).toContain("42");
    expect(commands.calls[0].args).toContain("--repo");
    expect(commands.calls[0].args).toContain("yonda/cockpit");
    expect(commands.calls[0].args).toContain("--json");
    expect(commands.calls[0].args).toContain("title,body");
  });

  it("returns empty string when body is null", async () => {
    const commands = new FakeCommands();
    commands.responses.push({
      stdout: JSON.stringify({ title: "T", body: null }),
      stderr: "",
    });
    const gh = new RealGitHubClient(commands, resolveToken);
    const res = await gh.fetchIssue("yonda/cockpit", 42);
    expect(res).toEqual({ title: "T", body: "" });
  });
});

describe("RealGitHubClient.updateIssueBody", () => {
  it("updates issue body with PATCH request", async () => {
    const commands = new FakeCommands();
    commands.responses.push({ stdout: "", stderr: "" });
    const gh = new RealGitHubClient(commands, resolveToken);
    await gh.updateIssueBody("yonda/cockpit", 101, "new body");
    expect(commands.calls[0].args).toContain("api");
    expect(commands.calls[0].args).toContain("--method");
    expect(commands.calls[0].args).toContain("PATCH");
    expect(commands.calls[0].args).toContain("/repos/yonda/cockpit/issues/101");
    const argsStr = commands.calls[0].args.join(" ");
    expect(argsStr).toContain("body=new body");
  });
});

describe("RealGitHubClient.closeIssue", () => {
  it("closes issue with correct command args", async () => {
    const commands = new FakeCommands();
    commands.responses.push({ stdout: "", stderr: "" });
    const gh = new RealGitHubClient(commands, resolveToken);
    await gh.closeIssue("yonda/cockpit", 101);
    expect(commands.calls[0].args).toContain("issue");
    expect(commands.calls[0].args).toContain("close");
    expect(commands.calls[0].args).toContain("101");
    expect(commands.calls[0].args).toContain("--repo");
    expect(commands.calls[0].args).toContain("yonda/cockpit");
  });
});

describe("RealGitHubClient.prStateForBranch", () => {
  const gh = (commands: CommandRunner) =>
    new RealGitHubClient(commands, resolveToken);

  it("returns none when no PR exists", async () => {
    const commands = new FakeCommands();
    commands.responses.push({ stdout: "[]", stderr: "" });
    expect(await gh(commands).prStateForBranch("r", "feature/1-x")).toEqual({
      kind: "none",
    });
  });

  it("maps a merged PR and queries only gh-pr-list valid fields", async () => {
    const commands = new FakeCommands();
    commands.responses.push({
      stdout: JSON.stringify([
        { url: "https://github.com/yonda/cockpit/pull/9", state: "MERGED", number: 9 },
      ]),
      stderr: "",
    });
    expect(await gh(commands).prStateForBranch("r", "feature/1-x")).toEqual({
      kind: "merged",
      url: "https://github.com/yonda/cockpit/pull/9",
    });
    // reviewThreads は gh pr list に存在しないフィールドなので --json に含めない
    const listArgs = commands.calls[0].args.join(" ");
    expect(listArgs).toContain("url,state,number");
    expect(listArgs).not.toContain("reviewThreads");
    // merged では graphql を呼ばない (list 1 回のみ)
    expect(commands.calls).toHaveLength(1);
  });

  /** OPEN PR: list -> graphql(reviewThreads) -> pr view(mergeable) の 3 応答を積む */
  const pushOpenResponses = (
    commands: FakeCommands,
    opts: { reviewCount?: number; mergeableJson?: unknown } = {},
  ) => {
    commands.responses.push({
      stdout: JSON.stringify([
        { url: "https://github.com/yonda/cockpit/pull/9", state: "OPEN", number: 9 },
      ]),
      stderr: "",
    });
    commands.responses.push({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: { reviewThreads: { totalCount: opts.reviewCount ?? 3 } },
          },
        },
      }),
      stderr: "",
    });
    commands.responses.push({
      stdout:
        opts.mergeableJson === undefined
          ? JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" })
          : JSON.stringify(opts.mergeableJson),
      stderr: "",
    });
  };

  it("maps an open PR, fetching review-thread count via graphql and mergeable via pr view", async () => {
    const commands = new FakeCommands();
    pushOpenResponses(commands);
    expect(await gh(commands).prStateForBranch("r", "feature/1-x")).toEqual({
      kind: "open",
      url: "https://github.com/yonda/cockpit/pull/9",
      reviewCommentCount: 3,
      mergeable: "MERGEABLE",
    });
    // OPEN のみ graphql を叩く
    expect(commands.calls[1].args).toContain("graphql");
    expect(commands.calls[1].args.join(" ")).toContain("reviewThreads");
    // 3 回目: gh pr view で mergeable/mergeStateStatus を取得
    const mergeArgs = commands.calls[2].args.join(" ");
    expect(commands.calls[2].args).toContain("pr");
    expect(commands.calls[2].args).toContain("view");
    expect(mergeArgs).toContain("mergeable,mergeStateStatus");
  });

  it("normalizes mergeStateStatus=DIRTY to CONFLICTING", async () => {
    const commands = new FakeCommands();
    pushOpenResponses(commands, {
      mergeableJson: { mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" },
    });
    const res = await gh(commands).prStateForBranch("r", "feature/1-x");
    expect(res).toMatchObject({ kind: "open", mergeable: "CONFLICTING" });
  });

  it("normalizes mergeable=CONFLICTING to CONFLICTING", async () => {
    const commands = new FakeCommands();
    pushOpenResponses(commands, {
      mergeableJson: { mergeable: "CONFLICTING", mergeStateStatus: "UNKNOWN" },
    });
    const res = await gh(commands).prStateForBranch("r", "feature/1-x");
    expect(res).toMatchObject({ kind: "open", mergeable: "CONFLICTING" });
  });

  it("normalizes mergeable=UNKNOWN (still computing) to UNKNOWN", async () => {
    const commands = new FakeCommands();
    pushOpenResponses(commands, {
      mergeableJson: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
    });
    const res = await gh(commands).prStateForBranch("r", "feature/1-x");
    expect(res).toMatchObject({ kind: "open", mergeable: "UNKNOWN" });
  });

  it("normalizes a clean PR to MERGEABLE", async () => {
    const commands = new FakeCommands();
    pushOpenResponses(commands, {
      mergeableJson: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
    });
    const res = await gh(commands).prStateForBranch("r", "feature/1-x");
    expect(res).toMatchObject({ kind: "open", mergeable: "MERGEABLE" });
  });

  it("falls back to UNKNOWN when the mergeable fetch fails (invalid JSON)", async () => {
    const commands = new FakeCommands();
    // list + graphql は正常、pr view は空文字を返し JSON.parse で失敗させる
    commands.responses.push({
      stdout: JSON.stringify([
        { url: "https://github.com/yonda/cockpit/pull/9", state: "OPEN", number: 9 },
      ]),
      stderr: "",
    });
    commands.responses.push({
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { totalCount: 0 } } } },
      }),
      stderr: "",
    });
    commands.responses.push({ stdout: "not json", stderr: "" });
    const res = await gh(commands).prStateForBranch("r", "feature/1-x");
    // mergeable 取得に失敗しても throw せず open 情報自体は返す
    expect(res).toEqual({
      kind: "open",
      url: "https://github.com/yonda/cockpit/pull/9",
      reviewCommentCount: 0,
      mergeable: "UNKNOWN",
    });
  });

  it("maps a closed PR", async () => {
    const commands = new FakeCommands();
    commands.responses.push({
      stdout: JSON.stringify([
        { url: "https://github.com/yonda/cockpit/pull/9", state: "CLOSED", number: 9 },
      ]),
      stderr: "",
    });
    expect(await gh(commands).prStateForBranch("r", "feature/1-x")).toEqual({
      kind: "closed",
      url: "https://github.com/yonda/cockpit/pull/9",
    });
  });
});

describe("RealGitHubClient.searchAssignedOpenIssues", () => {
  it("owner のトークンを env に載せて gh search を呼び JSON をマップする", async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const commands = {
      run: async (
        _c: string,
        args: string[],
        opts: { cwd: string; env?: Record<string, string> },
      ) => {
        calls.push({ args, env: opts.env });
        return {
          stdout: JSON.stringify([
            {
              number: 71,
              title: "owner 別トークン",
              url: "https://github.com/acme/widget/issues/71",
              createdAt: "2026-07-14T00:00:00Z",
              labels: [{ name: "pbi" }, { name: "runner" }],
              repository: { nameWithOwner: "acme/widget" },
            },
          ]),
          stderr: "",
        };
      },
    };
    const client = new RealGitHubClient(commands, (owner) => `tok-${owner}`);

    const res = await client.searchAssignedOpenIssues("acme");

    expect(res).toEqual([
      {
        repo: "acme/widget",
        issueNumber: 71,
        title: "owner 別トークン",
        url: "https://github.com/acme/widget/issues/71",
        createdAt: "2026-07-14T00:00:00Z",
        labels: ["pbi", "runner"],
      },
    ]);
    // owner の GH_TOKEN が env に載る
    expect(calls[0].env?.GH_TOKEN).toBe("tok-acme");
    // 検索条件: assignee:@me / is:open / is:issue のみ、ラベル絞り込みなし
    const argsStr = calls[0].args.join(" ");
    expect(calls[0].args).toContain("search");
    expect(calls[0].args).toContain("issues");
    expect(argsStr).toContain("--assignee @me");
    expect(argsStr).toContain("--state open");
    expect(argsStr).toContain("--owner acme");
    // ラベル絞り込みフラグ (--label) は使わない (--json の labels フィールドとは別)
    expect(calls[0].args).not.toContain("--label");
  });

  it("labels / repository が欠けていても安全にマップする", async () => {
    const commands = new FakeCommands();
    commands.responses.push({
      stdout: JSON.stringify([
        {
          number: 5,
          title: "T",
          url: "u",
          createdAt: "2026-07-14T00:00:00Z",
        },
      ]),
      stderr: "",
    });
    const client = new RealGitHubClient(commands, resolveToken);
    const res = await client.searchAssignedOpenIssues("acme");
    expect(res).toEqual([
      {
        repo: "",
        issueNumber: 5,
        title: "T",
        url: "u",
        createdAt: "2026-07-14T00:00:00Z",
        labels: [],
      },
    ]);
  });

  it("resolveToken が throw する場合はそのまま伝播する", async () => {
    const commands = new FakeCommands();
    const client = new RealGitHubClient(commands, () => {
      throw new Error("no token for owner");
    });
    await expect(client.searchAssignedOpenIssues("acme")).rejects.toThrow(
      "no token for owner",
    );
    // トークン解決前に落ちるので gh は呼ばれない
    expect(commands.calls).toHaveLength(0);
  });
});

describe("RealGitHubClient token resolution", () => {
  it("repo の owner トークンを解決して gh に渡す", async () => {
    const calls: Array<{ env?: Record<string, string> }> = [];
    const commands = {
      run: async (
        _c: string,
        _a: string[],
        opts: { cwd: string; env?: Record<string, string> },
      ) => {
        calls.push({ env: opts.env });
        return { stdout: JSON.stringify({ title: "t", body: "b" }), stderr: "" };
      },
    };
    const client = new RealGitHubClient(commands, (owner) => `tok-${owner}`);
    await client.fetchIssue("acme/widget", 1);
    expect(calls[0].env?.GH_TOKEN).toBe("tok-acme");
  });
});
