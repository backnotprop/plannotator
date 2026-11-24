/** Ship's one read of a pull request (inbox-ship-read.ts), from a GraphQL answer and a fake gh: never the real CLI. */
import { describe, expect, test } from "bun:test";
import { parseShipPull, readShipPull } from "./inbox-ship-read";

const answer = (pr: Record<string, unknown>, me = "charlie-dunn") => JSON.stringify({ data: { viewer: { login: me }, repository: { pullRequest: pr } } });
const base = {
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "CONFLICTING",
  mergeStateStatus: "DIRTY",
  latestReviews: { nodes: [{ state: "APPROVED", author: { login: "bob-tully" } }, { state: "CHANGES_REQUESTED", author: { login: "ada-novak" } }] },
  comments: { nodes: [{ id: "IC_1", createdAt: "2026-11-24T14:00:00Z", author: { login: "ada-novak" } }, { id: "IC_2", createdAt: "2026-11-24T14:30:00Z", author: { login: "charlie-dunn" } }] },
  reviewThreads: { nodes: [{ comments: { nodes: [{ id: "RC_1", createdAt: "2026-11-24T14:10:00Z", author: { login: "bob-tully" } }] } }] },
  commits: {
    nodes: [
      {
        commit: {
          author: { user: { login: "charlie-dunn" } },
          statusCheckRollup: {
            state: "FAILURE",
            contexts: { nodes: [{ __typename: "CheckRun", name: "e2e-checkout", conclusion: "FAILURE", status: "COMPLETED" }, { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS" }, { __typename: "StatusContext", context: "ci/deploy", state: "ERROR" }] },
          },
        },
      },
    ],
  },
};

describe("parseShipPull", () => {
  test("the facts the watch needs: failing checks by name, who asked for changes, the newest comment not the person's", () => {
    const read = parseShipPull(answer(base))!;
    expect(read.state).toBe("open");
    expect(read.failing).toEqual(["e2e-checkout", "ci/deploy"]);
    expect(read.checks).toBe("failure");
    expect(read.review).toBe("changes_requested");
    expect(read.reviewer).toBe("ada-novak");
    expect(read.conflicts).toBe(true);
    expect(read.head_mine).toBe(true);
    // IC_2 is the person's own (the agent answering as them): the newest by someone else is Bob's code comment.
    expect(read.comment).toBe("RC_1");
    expect(read.commenter).toBe("bob-tully");
  });

  test("merged, draft and behind", () => {
    expect(parseShipPull(answer({ ...base, state: "MERGED", mergedAt: "2026-11-24T14:47:00Z" }))!.merged_at).toBe("2026-11-24T14:47:00Z");
    expect(parseShipPull(answer({ ...base, isDraft: true }))!.state).toBe("draft");
    expect(parseShipPull(answer({ ...base, mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" }))!.behind).toBe(true);
    expect(parseShipPull(answer(base, "bob-tully"))!.head_mine).toBe(false);
  });

  test("not an answer: null", () => {
    expect(parseShipPull("nope")).toBeNull();
    expect(parseShipPull(JSON.stringify({ data: { repository: { pullRequest: null } } }))).toBeNull();
  });
});

describe("readShipPull", () => {
  test("one gh graphql call on the PR's host; a GitLab merge request and a failed call read null", async () => {
    const calls: string[][] = [];
    const run = async (cli: string, args: string[]) => {
      calls.push([cli, ...args]);
      return { exitCode: 0, stdout: answer(base), stderr: "" };
    };
    const read = await readShipPull(run as never, { host: "github.com", repo: "harbor/fern-api", number: 614 });
    expect(read?.failing).toContain("e2e-checkout");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 5)).toEqual(["gh", "api", "graphql", "--hostname", "github.com"]);
    expect(calls[0]).toContain("number=614");
    expect(await readShipPull(run as never, { host: "gitlab.com", repo: "harbor/fern-api", number: 1, platform: "gitlab" })).toBeNull();
    const failing = async () => ({ exitCode: 1, stdout: "", stderr: "no" });
    expect(await readShipPull(failing as never, { host: "github.com", repo: "harbor/fern-api", number: 614 })).toBeNull();
  });
});
