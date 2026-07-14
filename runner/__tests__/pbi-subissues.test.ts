import { describe, expect, it } from "vitest";
import type { GitHubClient, PrState } from "../github";
import type { SubTask } from "../../lib/pbi/types";
import { materializeSubIssues, subTaskBranch } from "../pbi-subissues";

const tasks: SubTask[] = [
  {
    key: "t1",
    title: "型を作る",
    goal: "g",
    deliverable: "d",
    acceptanceCriteria: [],
    dependsOn: [],
  },
  {
    key: "t2",
    title: "store を作る",
    goal: "g",
    deliverable: "d",
    acceptanceCriteria: [],
    dependsOn: ["t1"],
  },
];

class FakeGitHub implements GitHubClient {
  created: { parent: number; title: string }[] = [];
  private nextNumber = 100;
  async fetchIssue() {
    return { title: "", body: "" };
  }
  async createSubIssue(_repo: string, parent: number, task: SubTask) {
    const number = this.nextNumber++;
    this.created.push({ parent, title: task.title });
    return {
      number,
      url: `https://github.com/yonda/cockpit/issues/${number}`,
    };
  }
  async updateIssueBody() {}
  async closeIssue() {}
  async prStateForBranch(): Promise<PrState> {
    return { kind: "none" };
  }
  async searchAssignedOpenIssues() {
    return [];
  }
}

describe("subTaskBranch", () => {
  it("names the branch from the issue number and title", () => {
    expect(subTaskBranch(101, "Add store")).toBe("feature/101-add-store");
  });
});

describe("materializeSubIssues", () => {
  it("creates one sub-issue per task and returns pending records", async () => {
    const gh = new FakeGitHub();
    const records = await materializeSubIssues(gh, "yonda/cockpit", 42, tasks);

    expect(gh.created).toEqual([
      { parent: 42, title: "型を作る" },
      { parent: 42, title: "store を作る" },
    ]);
    expect(records.map((r) => r.state)).toEqual(["pending", "pending"]);
    expect(records[0].issueNumber).toBe(100);
    // buildBranchName with non-ASCII title falls back to "feature/<number>-issue"
    expect(records[0].branch).toBe("feature/100-issue");
    // 依存関係は key ベースで保持される
    expect(records[1].dependsOn).toEqual(["t1"]);
  });
});
