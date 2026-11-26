/**
 * Every GraphQL query the Inbox sends a GitLab host stays well under GitLab's complexity limit (250 for a signed-in
 * user on a default install). A query over it is answered with an error and no data, so its list reads as
 * unavailable on every GitLab. How the estimate counts: tests/helpers/gitlab-graphql-complexity.ts. The budget here
 * (200) leaves room for a field or two before GitLab would refuse a query.
 */
import { describe, expect, test } from "bun:test";
import { estimateGitlabComplexity, estimateGqlFields, parseGqlQuery } from "../../tests/helpers/gitlab-graphql-complexity";
import { GITLAB_PULLS_QUERIES, gitlabOthersQueries, GITLAB_PROJECTS_PER_QUERY, INBOX_PULLS_OTHERS_CALLS_MAX } from "./inbox-pulls";

const BUDGET = 200;
const GITLAB_SIGNED_IN_LIMIT = 250;

/** The Others queries at their largest: more projects than a read asks, with subgroup paths. */
function largestOthersQueries(): string[] {
  const projects = Array.from({ length: GITLAB_PROJECTS_PER_QUERY * INBOX_PULLS_OTHERS_CALLS_MAX + 3 }, (_, i) => `group-${i}/sub/project-${i}`);
  return gitlabOthersQueries(projects).queries;
}

describe("GitLab query complexity", () => {
  test("the estimate scores the person's four lists asked in one query over GitLab's limit", () => {
    const lists = GITLAB_PULLS_QUERIES.flatMap((q) => parseGqlQuery(q)[0]!.children.filter((f) => f.name !== "username"));
    expect(lists.length).toBe(4);
    const together = estimateGqlFields([{ name: "currentUser", args: {}, children: [{ name: "username", args: {}, children: [] }, ...lists] }]);
    expect(together).toBeGreaterThan(GITLAB_SIGNED_IN_LIMIT);
  });

  test("each query of the person's own lists is under the budget", () => {
    expect(GITLAB_PULLS_QUERIES.length).toBeGreaterThan(0);
    for (const query of GITLAB_PULLS_QUERIES) expect(estimateGitlabComplexity(query)).toBeLessThan(BUDGET);  });

  test("each Others query is under the budget", () => {
    const queries = largestOthersQueries();
    expect(queries.length).toBe(INBOX_PULLS_OTHERS_CALLS_MAX);
    for (const query of queries) expect(estimateGitlabComplexity(query)).toBeLessThan(BUDGET);
  });

  test("a field with no known weight fails the estimate, saying where to look its weight up", () => {
    expect(() => estimateGitlabComplexity("query { currentUser { username userPermissions { canMerge } } }")).toThrow(/"userPermissions".*merge_request_type\.rb/);
  });

  test("a resolver connection asked without first: is scored at GitLab's page size", () => {
    const without = estimateGitlabComplexity("query { currentUser { authoredMergeRequests(state: opened) { count nodes { iid } } } }");
    const hundred = estimateGitlabComplexity("query { currentUser { authoredMergeRequests(state: opened, first: 100) { count nodes { iid } } } }");
    const one = estimateGitlabComplexity("query { currentUser { authoredMergeRequests(state: opened, first: 1) { count nodes { iid } } } }");
    expect(without).toBe(hundred);
    expect(without).toBeGreaterThan(one);
  });

  test("a search: argument costs 5 more", () => {
    const plain = estimateGitlabComplexity('query { project(fullPath: "a/b") { fullPath } }');
    const searched = estimateGitlabComplexity('query { project(fullPath: "a/b", search: "fix") { fullPath } }');
    expect(searched - plain).toBe(5);
  });

  test("each query is under GitLab's 10,000-character limit", () => {
    for (const query of [...GITLAB_PULLS_QUERIES, ...largestOthersQueries()]) expect(query.length).toBeLessThan(10_000);
  });
});
