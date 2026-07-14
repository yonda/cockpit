import { describe, expect, it } from "vitest";
import type { AssignedIssue, AssignedIssuesResult } from "../../lib/repos/types";
import type { GitHubClient } from "../github";
import { RepoRegistry, type RepoConfig } from "../repo-registry";
import { handleReposRequest, listAssignedIssues } from "../repos-server";

function repoConfig(repo: string): RepoConfig {
  return { repo, path: "/tmp/x", baseBranch: "main", tokenOwner: repo.split("/")[0] };
}

function issue(repo: string, issueNumber: number): AssignedIssue {
  return {
    repo,
    issueNumber,
    title: `issue ${issueNumber}`,
    url: `https://github.com/${repo}/issues/${issueNumber}`,
    createdAt: "2026-07-14T00:00:00Z",
    labels: ["cockpit"],
  };
}

/** searchAssignedOpenIssues だけ差し替え可能な fake GitHubClient。 */
function fakeGithub(
  search: (owner: string) => Promise<AssignedIssue[]>,
): GitHubClient & { searchedOwners: string[] } {
  const searchedOwners: string[] = [];
  return {
    searchedOwners,
    fetchIssue: async () => ({ title: "", body: "" }),
    createSubIssue: async () => ({ number: 1, url: "" }),
    updateIssueBody: async () => {},
    closeIssue: async () => {},
    prStateForBranch: async () => ({ kind: "none" as const }),
    searchAssignedOpenIssues: async (owner: string) => {
      searchedOwners.push(owner);
      return search(owner);
    },
  };
}

describe("listAssignedIssues", () => {
  it("excludes issues from repos that are not in the registry (intersect)", async () => {
    const registry = new RepoRegistry([repoConfig("acme/app")]);
    const github = fakeGithub(async () => [
      issue("acme/app", 1),
      issue("acme/unregistered", 2),
    ]);

    const result = await listAssignedIssues({ registry, github });

    expect(result.issues).toEqual([issue("acme/app", 1)]);
    expect(result.errors).toEqual([]);
  });

  it("groups registered repos by owner and searches each owner once", async () => {
    const registry = new RepoRegistry([
      repoConfig("acme/app"),
      repoConfig("acme/tools"),
      repoConfig("globex/web"),
    ]);
    const github = fakeGithub(async (owner) =>
      owner === "acme"
        ? [issue("acme/app", 1), issue("acme/tools", 2)]
        : [issue("globex/web", 3)],
    );

    const result = await listAssignedIssues({ registry, github });

    expect(github.searchedOwners.sort()).toEqual(["acme", "globex"]);
    expect(result.issues.map((i) => i.repo).sort()).toEqual([
      "acme/app",
      "acme/tools",
      "globex/web",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("keeps other owners' results when one owner's search fails (fail-safe)", async () => {
    const registry = new RepoRegistry([
      repoConfig("acme/app"),
      repoConfig("globex/web"),
    ]);
    const github = fakeGithub(async (owner) => {
      if (owner === "globex") throw new Error("token not found for globex");
      return [issue("acme/app", 1)];
    });

    const result = await listAssignedIssues({ registry, github });

    expect(result.issues).toEqual([issue("acme/app", 1)]);
    expect(result.errors).toEqual([
      { owner: "globex", message: "token not found for globex" },
    ]);
  });

  it("returns empty result for an empty registry without searching", async () => {
    const github = fakeGithub(async () => [issue("acme/app", 1)]);

    const result = await listAssignedIssues({
      registry: new RepoRegistry([]),
      github,
    });

    expect(result).toEqual({ issues: [], errors: [] });
    expect(github.searchedOwners).toEqual([]);
  });
});

describe("handleReposRequest", () => {
  it("dispatches repos.assignedIssues and returns the merged result", async () => {
    const registry = new RepoRegistry([repoConfig("acme/app")]);
    const github = fakeGithub(async () => [issue("acme/app", 1)]);

    const response = await handleReposRequest(
      { id: "r1", method: "repos.assignedIssues", params: {} },
      { registry, github },
    );

    const result = response.result as AssignedIssuesResult;
    expect(response.error).toBeUndefined();
    expect(result.issues).toEqual([issue("acme/app", 1)]);
  });

  it("responds with an error (not a crash) even when a search fails", async () => {
    const registry = new RepoRegistry([repoConfig("acme/app")]);
    const github = fakeGithub(async () => {
      throw new Error("boom");
    });

    const response = await handleReposRequest(
      { id: "r1", method: "repos.assignedIssues", params: {} },
      { registry, github },
    );

    const result = response.result as AssignedIssuesResult;
    expect(result.issues).toEqual([]);
    expect(result.errors).toEqual([{ owner: "acme", message: "boom" }]);
  });

  it("rejects unknown repos.* methods", async () => {
    const response = await handleReposRequest(
      {
        id: "r1",
        method: "repos.nope",
        params: {},
      } as unknown as Parameters<typeof handleReposRequest>[0],
      { registry: new RepoRegistry([]), github: fakeGithub(async () => []) },
    );

    expect(response.error?.message).toBe("unknown repos method");
  });
});
