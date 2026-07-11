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

    const gh = new RealGitHubClient(commands, "/repo");
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
    const gh = new RealGitHubClient(commands, "/repo");
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
    const gh = new RealGitHubClient(commands, "/repo");
    const res = await gh.fetchIssue("yonda/cockpit", 42);
    expect(res).toEqual({ title: "T", body: "" });
  });
});

describe("RealGitHubClient.updateIssueBody", () => {
  it("updates issue body with PATCH request", async () => {
    const commands = new FakeCommands();
    commands.responses.push({ stdout: "", stderr: "" });
    const gh = new RealGitHubClient(commands, "/repo");
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
    const gh = new RealGitHubClient(commands, "/repo");
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
    new RealGitHubClient(commands, "/repo");

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

  it("maps an open PR, fetching review-thread count via graphql", async () => {
    const commands = new FakeCommands();
    commands.responses.push({
      stdout: JSON.stringify([
        { url: "https://github.com/yonda/cockpit/pull/9", state: "OPEN", number: 9 },
      ]),
      stderr: "",
    });
    // 2 回目の呼び出し: gh api graphql で reviewThreads.totalCount
    commands.responses.push({
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { totalCount: 3 } } } },
      }),
      stderr: "",
    });
    expect(await gh(commands).prStateForBranch("r", "feature/1-x")).toEqual({
      kind: "open",
      url: "https://github.com/yonda/cockpit/pull/9",
      reviewCommentCount: 3,
    });
    // OPEN のみ graphql を叩く
    expect(commands.calls[1].args).toContain("graphql");
    expect(commands.calls[1].args.join(" ")).toContain("reviewThreads");
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
