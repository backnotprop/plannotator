/**
 * A PR's details beside its diff. What regresses:
 *  - a reviewer shown standing where the forge does not: a later comment taking back an approval, a dismissed review
 *    still counting, someone asked again still "approved", a GitLab approver turned into "waiting", the author listed;
 *  - a check reading as passed while it runs or after it failed, an address that is not https becoming a link;
 *  - a comment lost (a review's words, a line comment), or out of time order; a deleted account named "ghost";
 *  - the avatar route's allow-list losing the people the details named at the next list, or keeping them after the PR
 *    left the list; a read for a PR the list did not name; a failed read kept; asking the forge twice for one read.
 */
import { describe, expect, test } from "bun:test";
import { createInboxPulls, InboxPullsError } from "./inbox-pulls";
import { pullDetailsOf } from "./inbox-pull-details";
import type { PRContext } from "@plannotator/shared/pr-types";

const context = (fields: Partial<PRContext> = {}): PRContext => ({
  body: "",
  state: "OPEN",
  isDraft: false,
  labels: [],
  reviewDecision: "",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  comments: [],
  reviews: [],
  reviewThreads: [],
  checks: [],
  linkedIssues: [],
  ...fields,
});
const review = (author: string, state: string, submittedAt: string, body = "") => ({ id: `${author}-${submittedAt}`, author, state, body, submittedAt });
const standing = (fields: Partial<PRContext>, author: string | null = "dana") =>
  Object.fromEntries(pullDetailsOf("k", context(fields), author).answer.reviewers.map((r) => [r.login, r.state]));

describe("reviewers", () => {
  test("each person's last review that counts", () => {
    expect(standing({ reviews: [review("tomas", "APPROVED", "2026-11-01T10:00:00Z"), review("tomas", "COMMENTED", "2026-11-01T11:00:00Z")] })).toEqual({ tomas: "approved" });
    expect(standing({ reviews: [review("mei", "APPROVED", "2026-11-01T10:00:00Z"), review("mei", "CHANGES_REQUESTED", "2026-11-01T11:00:00Z")] })).toEqual({ mei: "changes" });
    expect(standing({ reviews: [review("mei", "CHANGES_REQUESTED", "2026-11-01T11:00:00Z"), review("mei", "APPROVED", "2026-11-01T10:00:00Z")] })).toEqual({ mei: "changes" });
    expect(standing({ reviews: [review("jun", "APPROVED", "2026-11-01T10:00:00Z"), review("jun", "DISMISSED", "2026-11-01T11:00:00Z")] })).toEqual({});
    expect(standing({ reviews: [review("jun", "PENDING", "")] })).toEqual({});
  });

  test("asked: waiting, again on GitHub even after approving; a GitLab approver stays approved", () => {
    expect(standing({ requestedReviewers: [{ login: "ana" }, { login: "northwind/core", isTeam: true }] })).toEqual({ ana: "waiting", "northwind/core": "waiting" });
    expect(standing({ reviews: [review("tomas", "APPROVED", "2026-11-01T10:00:00Z")], requestedReviewers: [{ login: "tomas" }] })).toEqual({ tomas: "waiting" });
    expect(standing({ reviews: [review("tomas", "APPROVED", "")], requestedReviewers: [{ login: "tomas" }, { login: "ana" }] })).toEqual({ tomas: "approved", ana: "waiting" });
  });

  test("never the PR's author; an app and a team say so", () => {
    expect(standing({ reviews: [review("dana", "COMMENTED", "2026-11-01T10:00:00Z")] })).toEqual({});
    const { reviewers } = pullDetailsOf("k", context({ requestedReviewers: [{ login: "copilot[bot]", isBot: true }, { login: "n/core", isTeam: true }] }), "dana").answer;
    expect(reviewers).toEqual([{ login: "copilot[bot]", state: "waiting", bot: true }, { login: "n/core", state: "waiting", team: true }]);
  });
});

describe("checks", () => {
  const check = (name: string, status: string, conclusion: string | null, detailsUrl = "") => ({ name, status, conclusion, workflowName: "", detailsUrl });
  const states = (checks: PRContext["checks"]) => pullDetailsOf("k", context({ checks }), null).answer.checks;

  test("running until done; a failure in any of its words; skipped says so", () => {
    expect(states([check("a", "IN_PROGRESS", null), check("b", "COMPLETED", "SUCCESS")]).map((c) => c.state)).toEqual(["pending", "pass"]);
    for (const word of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]) {
      expect([word, states([check("a", "COMPLETED", word)])[0]!.state]).toEqual([word, "fail"]);
    }
    expect(states([check("a", "COMPLETED", "SKIPPED")])[0]).toEqual({ name: "a", state: "pass", note: "Skipped" });
  });

  test("a page is a link only over https", () => {
    expect(states([check("a", "COMPLETED", "SUCCESS", "https://ci.example/1")])[0]!.url).toBe("https://ci.example/1");
    for (const bad of ["javascript:alert(1)", "http://ci.example/1", "not an address"]) expect(states([check("a", "COMPLETED", "SUCCESS", bad)])[0]!.url).toBeUndefined();
  });
});

describe("comments", () => {
  test("the conversation, a review's words and line comments, in time order, every one", () => {
    const { answer } = pullDetailsOf(
      "k",
      context({
        comments: [{ id: "c1", author: "kim", body: "later", createdAt: "2026-11-03T00:00:00Z", url: "u1" }],
        reviews: [review("tomas", "COMMENTED", "2026-11-02T00:00:00Z", "a review's words"), review("mei", "APPROVED", "2026-11-05T00:00:00Z")],
        reviewThreads: [{ id: "t", isResolved: false, isOutdated: false, path: "src/a.ts", line: 31, startLine: null, diffSide: "RIGHT", comments: [{ id: "r1", author: "jun", body: "on a line", createdAt: "2026-11-01T00:00:00Z", url: "u2" }] }],
      }),
      "dana",
    );
    expect(answer.comments.map((c) => c.body)).toEqual(["on a line", "a review's words", "later"]);
    expect(answer.comments[0]).toMatchObject({ file: "src/a.ts", line: 31 });
  });

  test("a deleted account is no name, not 'ghost'", () => {
    const { answer } = pullDetailsOf("k", context({ comments: [{ id: "1", author: "ghost", body: "x", createdAt: "", url: "" }, { id: "2", author: "", body: "y", createdAt: "", url: "" }] }), null);
    expect(answer.comments.map((c) => c.author)).toEqual(["", ""]);
  });

  test("the pictures the forge gave for the people named", () => {
    const { avatars } = pullDetailsOf(
      "k",
      context({
        comments: [{ id: "1", author: "kim", avatarUrl: "https://a/kim", body: "x", createdAt: "", url: "" }],
        reviews: [{ ...review("tomas", "APPROVED", "2026-11-01T00:00:00Z"), avatarUrl: "https://a/tomas" }],
        requestedReviewers: [{ login: "ana", avatarUrl: "https://a/ana" }, { login: "n/core", isTeam: true }],
      }),
      "dana",
    );
    expect(avatars).toEqual({ kim: "https://a/kim", tomas: "https://a/tomas", ana: "https://a/ana" });
  });
});

describe("reading them through the list", () => {
  const repos = [{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }];
  const KEY = "github.com/northwind/billing-svc#412";
  const pull = (number: number, updatedAt = "2026-11-03T10:00:00Z") => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/northwind/billing-svc/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    updatedAt,
    mergedAt: null,
    baseRefName: "main",
    headRefName: `branch-${number}`,
    headRefOid: String(number).padStart(40, "a"),
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: "REVIEW_REQUIRED",
    repository: { nameWithOwner: "northwind/billing-svc" },
    headRepository: { nameWithOwner: "northwind/billing-svc" },
    author: { login: "dana", avatarUrl: "https://a/dana" },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [] },
  });
  function forge() {
    const state = { listed: [pull(412)], view: { exitCode: 0 }, views: 0, others: 0 };
    const run = async (cli: string, args: string[]) => {
      const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
      if (args[0] === "auth") return cli === "gh" ? ok({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }) : { stdout: "", stderr: "no", exitCode: 1 };
      if (args[0] === "pr" && args[1] === "view") {
        state.views++;
        if (state.view.exitCode) return { stdout: "", stderr: "HTTP 502", exitCode: 1 };
        return ok({ body: "Why.", state: "OPEN", isDraft: false, labels: [{ name: "billing", color: "" }], comments: [{ id: "1", author: { login: "kim" }, body: "x", createdAt: "2026-11-01T00:00:00Z", url: "u" }], reviews: [{ id: "2", author: { login: "tomas" }, state: "APPROVED", body: "", submittedAt: "2026-11-01T00:00:00Z" }], reviewDecision: "", mergeable: "", mergeStateStatus: "", statusCheckRollup: [{ context: "ci/status", state: "PENDING", targetUrl: "https://ci/1" }], closingIssuesReferences: [] });
      }
      if (args[0] === "api" && args[1]?.endsWith("/requested_reviewers")) return ok({ users: [{ login: "ana", avatar_url: "https://a/ana", type: "User" }], teams: [{ slug: "core" }] });
      if (args.some((a) => a.includes("reviewThreads(first"))) {
        return ok({ data: { repository: { pullRequest: { comments: { nodes: [{ author: { __typename: "User", login: "kim", avatarUrl: "https://a/kim" } }] }, reviews: { nodes: [{ author: { __typename: "User", login: "tomas", avatarUrl: "https://a/tomas" } }] }, reviewThreads: { nodes: [] } } } } });
      }
      if (args.some((a) => a.startsWith("query=query InboxPullsOthers"))) return ok({ data: { viewer: { login: "dana" }, others0: { issueCount: 0, nodes: [] } } });
      if (args.includes("graphql")) return ok({ data: { viewer: { login: "dana" }, requested: { nodes: [] }, authored: { nodes: state.listed }, merged: { nodes: [] } } });
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    };
    return { state, run: run as never };
  }

  test("GitHub's answers in one shape, a commit status too", async () => {
    const f = forge();
    const pulls = createInboxPulls({ run: f.run });
    await pulls.list(repos);
    const answer = await pulls.details(KEY);
    expect(answer).toMatchObject({ key: KEY, description: "Why.", labels: ["billing"] });
    expect(answer.reviewers).toEqual([{ login: "tomas", state: "approved" }, { login: "ana", state: "waiting" }, { login: "northwind/core", state: "waiting", team: true }]);
    expect(answer.checks).toEqual([{ name: "ci/status", state: "pending", url: "https://ci/1" }]);
  });

  test("one read while it is fresh; a new push asks again; a failure is not kept", async () => {
    let now = 1_000_000;
    const f = forge();
    const pulls = createInboxPulls({ run: f.run, now: () => now });
    await pulls.list(repos);
    await Promise.all([pulls.details(KEY), pulls.details(KEY)]);
    await pulls.details(KEY);
    expect(f.state.views).toBe(1);
    f.state.listed = [pull(412, "2026-11-03T11:00:00Z")];
    now += 10 * 60_000;
    await pulls.list(repos, { refresh: true });
    await pulls.details(KEY);
    expect(f.state.views).toBe(2);
    f.state.listed = [pull(412, "2026-11-03T12:00:00Z")];
    now += 10 * 60_000;
    await pulls.list(repos, { refresh: true });
    f.state.view.exitCode = 1;
    await expect(pulls.details(KEY)).rejects.toMatchObject({ code: "pull_details_failed" });
    f.state.view.exitCode = 0;
    expect((await pulls.details(KEY)).labels).toEqual(["billing"]);
  });

  test("only for a PR the list named", async () => {
    const pulls = createInboxPulls({ run: forge().run });
    await pulls.list(repos);
    const refused = await pulls.details("github.com/elsewhere/thing#9").catch((cause) => cause);
    expect(refused).toBeInstanceOf(InboxPullsError);
    expect(refused.code).toBe("pull_unknown");
  });

  test("the people it named stay allowed across a new list, and go with the PR", async () => {
    let now = 1_000_000;
    const f = forge();
    const pulls = createInboxPulls({ run: f.run, now: () => now });
    await pulls.list(repos);
    expect(pulls.avatarUrls("github.com")).toEqual({ dana: "https://a/dana" });
    await pulls.details(KEY);
    const named = { dana: "https://a/dana", kim: "https://a/kim", tomas: "https://a/tomas", ana: "https://a/ana" };
    expect(pulls.avatarUrls("github.com")).toEqual(named);
    now += 10 * 60_000;
    await pulls.list(repos, { refresh: true });
    expect(pulls.avatarUrls("github.com")).toEqual(named);
    f.state.listed = [pull(500)];
    now += 10 * 60_000;
    await pulls.list(repos, { refresh: true });
    expect(pulls.avatarUrls("github.com")).toEqual({ dana: "https://a/dana" });
  });
});
