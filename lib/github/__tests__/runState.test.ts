import { describe, expect, it } from "vitest";
import { buildRunStateQuery } from "../queries";

describe("buildRunStateQuery", () => {
  it("issue番号とPR番号をそれぞれエイリアス付きフィールドにする", () => {
    const query = buildRunStateQuery([70, 71], [77]);
    expect(query).toContain("i70: issue(number: 70)");
    expect(query).toContain("i71: issue(number: 71)");
    expect(query).toContain("p77: pullRequest(number: 77)");
    expect(query).toContain("$owner: String!");
    expect(query).toContain("$name: String!");
  });

  it("issue番号のみ・PR番号のみでもフィールドを生成する", () => {
    const issuesOnly = buildRunStateQuery([70], []);
    expect(issuesOnly).toContain("i70: issue");
    expect(issuesOnly).not.toContain("pullRequest");

    const prsOnly = buildRunStateQuery([], [77]);
    expect(prsOnly).toContain("p77: pullRequest");
    expect(prsOnly).not.toContain(": issue(");
  });
});
