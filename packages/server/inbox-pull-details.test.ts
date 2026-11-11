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
    // As gh answers them: a check not done has an empty conclusion, not null.
    expect(states([check("a", "QUEUED", ""), check("b", "IN_PROGRESS", "")]).map((c) => c.state)).toEqual(["pending", "pending"]);
    // Each failure says how, in the forge's own word.
    const how = { FAILURE: "Failed", TIMED_OUT: "Timed out", CANCELLED: "Cancelled", ACTION_REQUIRED: "Action required", STARTUP_FAILURE: "Startup failure", ERROR: "Error" };
    for (const [word, note] of Object.entries(how)) {
      const [one] = states([check("a", "COMPLETED", word)]);
      expect([word, one!.state, one!.note]).toEqual([word, "fail", note]);
    }
    expect(states([check("a", "COMPLETED", "SKIPPED")])[0]).toEqual({ name: "a", state: "pass", note: "Skipped" });
  });

  test("a stale check, overtaken by a newer run, is done and quiet: never running forever", () => {
    expect(states([check("a", "COMPLETED", "STALE")])[0]).toEqual({ name: "a", state: "pass", note: "Stale" });
    // Some answers leave a stale check's status where it was.
    expect(states([check("a", "IN_PROGRESS", "STALE")])[0]).toEqual({ name: "a", state: "pass", note: "Stale" });
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

  /** The forge, with some of its answers changed: `change` returns the answer to give instead, or nothing. */
  const changed = (f: ReturnType<typeof forge>, change: (args: string[], stdout: string) => unknown) => (async (cli: string, args: string[]) => {
    const answer = await (f.run as unknown as (cli: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>)(cli, args);
    const instead = change(args, answer.stdout);
    return instead === undefined ? answer : typeof instead === "number" ? { stdout: "", stderr: "HTTP 502", exitCode: instead } : { stdout: JSON.stringify(instead), stderr: "", exitCode: 0 };
  }) as never;
  const isView = (args: string[]) => args[0] === "pr" && args[1] === "view";
  const threadsField = (args: string[], name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  const thread = (id: string, comments: { pageInfo?: unknown; nodes: unknown[] }) => ({ id, isResolved: false, isOutdated: false, path: "src/a.ts", line: 3, startLine: null, diffSide: "RIGHT", comments });
  const noted = (id: string) => ({ id, author: { __typename: "User", login: "kim", avatarUrl: "https://a/kim" }, body: id, createdAt: "2026-11-01T00:00:00Z", url: "u" });
  const threadPage = (threads: unknown[], next?: string) => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes: threads } } } } });

  test("a queued check and a skipped one, as gh answered them on a real PR: running, skipped not passed, and stale done", async () => {
    const f = forge();
    // Two rows of #2671's statusCheckRollup, as captured.
    const rollup = [
      { __typename: "CheckRun", completedAt: "0001-01-01T00:00:00Z", conclusion: "", detailsUrl: "https://github.com/backnotprop/plannotator/actions/runs/42096823925/job/127488930196", name: "Gitleaks", startedAt: "2026-11-05T19:44:54Z", status: "QUEUED", workflowName: "Security Scanning" },
      { __typename: "CheckRun", completedAt: "2026-11-05T19:44:53Z", conclusion: "SKIPPED", detailsUrl: "https://github.com/backnotprop/plannotator/actions/runs/42096823940/job/127488933395", name: "Inbox Claude Code connection (the mod against the compiled binary)", startedAt: "2026-11-05T19:44:54Z", status: "COMPLETED", workflowName: "Inbox Claude Code connection" },
      { __typename: "CheckRun", completedAt: "2026-11-05T19:44:53Z", conclusion: "STALE", detailsUrl: "", name: "Old", startedAt: "", status: "COMPLETED", workflowName: "" },
    ];
    const pulls = createInboxPulls({ run: changed(f, (args, stdout) => (isView(args) ? { ...JSON.parse(stdout), statusCheckRollup: rollup } : undefined)) });
    await pulls.list(repos);
    const answer = await pulls.details(KEY);
    expect(answer.checks.map((c) => [c.state, c.note])).toEqual([["pending", undefined], ["pass", "Skipped"], ["pass", "Stale"]]);
  });

  test("a description of only a PR template's comments is no description", async () => {
    const f = forge();
    const pulls = createInboxPulls({ run: changed(f, (args, stdout) => (isView(args) ? { ...JSON.parse(stdout), body: "<!-- Please describe the change -->\n\n<!-- and how you tested it -->\n" } : undefined)) });
    await pulls.list(repos);
    expect((await pulls.details(KEY)).description).toBeNull();
  });

  test("every comment on a line is read, past a page of threads and a thread's page of comments", async () => {
    const f = forge();
    const asked: (string | undefined)[] = [];
    const pulls = createInboxPulls({
      run: changed(f, (args) => {
        if (threadsField(args, "query")?.includes("PullRequestReviewThread")) {
          expect(threadsField(args, "id")).toBe("t1");
          expect(threadsField(args, "after")).toBe("c50");
          return { data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [noted("t1-2")] } } } };
        }
        if (!threadsField(args, "query")?.includes("reviewThreads(first")) return undefined;
        asked.push(threadsField(args, "threadsAfter"));
        return threadsField(args, "threadsAfter")
          ? threadPage([thread("t2", { nodes: [noted("t2-1")] })])
          : threadPage([thread("t1", { pageInfo: { hasNextPage: true, endCursor: "c50" }, nodes: [noted("t1-1")] })], "t100");
      }),
    });
    await pulls.list(repos);
    const answer = await pulls.details(KEY);
    expect(asked).toEqual([undefined, "t100"]);
    expect(answer.comments.map((c) => c.body).filter((body) => body.startsWith("t"))).toEqual(["t1-1", "t1-2", "t2-1"]);
    expect(answer.threads_incomplete).toBeUndefined();
  });

  test("each thread whole, for the page to draw on its line: its side, resolved, outdated, a comment the forge hides", async () => {
    const f = forge();
    let asked = "";
    const pulls = createInboxPulls({
      run: changed(f, (args) => {
        if (!threadsField(args, "query")?.includes("reviewThreads(first")) return undefined;
        asked = threadsField(args, "query") ?? "";
        return threadPage([
          { ...thread("t1", { nodes: [noted("t1-1"), { ...noted("t1-2"), author: { __typename: "Bot", login: "lint[bot]" }, isMinimized: true, minimizedReason: "OFF_TOPIC" }] }), line: 9, startLine: 7, diffSide: "LEFT", isResolved: true },
          { ...thread("t2", { nodes: [noted("t2-1")] }), line: null, startLine: null, isOutdated: true },
          { ...thread("empty", { nodes: [] }) },
          // From a removed line to an added one: the two numbers are from two files, so only its end line is kept.
          { ...thread("t3", { nodes: [noted("t3-1")] }), line: 9, startLine: 3, startDiffSide: "LEFT", diffSide: "RIGHT" },
        ]);
      }),
    });
    await pulls.list(repos);
    const answer = await pulls.details(KEY);
    expect(asked).toContain("isMinimized");
    expect(asked).toContain("startDiffSide");
    expect(answer.threads).toEqual([
      {
        id: "t1", file: "src/a.ts", line: 9, start_line: 7, side: "old", resolved: true, outdated: false,
        comments: [
          { id: "t1-1", author: "kim", at: "2026-11-01T00:00:00Z", body: "t1-1", url: "u", file: "src/a.ts", line: 9 },
          { id: "t1-2", author: "lint[bot]", bot: true, at: "2026-11-01T00:00:00Z", body: "t1-2", url: "u", file: "src/a.ts", line: 9, hidden: "off-topic" },
        ],
      },
      {
        id: "t2", file: "src/a.ts", line: null, start_line: null, side: "new", resolved: false, outdated: true,
        comments: [{ id: "t2-1", author: "kim", at: "2026-11-01T00:00:00Z", body: "t2-1", url: "u", file: "src/a.ts" }],
      },
      {
        id: "t3", file: "src/a.ts", line: 9, start_line: null, side: "new", resolved: false, outdated: false,
        comments: [{ id: "t3-1", author: "kim", at: "2026-11-01T00:00:00Z", body: "t3-1", url: "u", file: "src/a.ts", line: 9 }],
      },
    ]);
    // The flat list keeps them too, with the hidden mark.
    expect(answer.comments.find((c) => c.id === "t1-2")?.hidden).toBe("off-topic");
  });

  test("a page of threads that fails: what was read shows, says it is not all, keeps its faces, and is read again", async () => {
    const f = forge();
    let failing = true;
    const pulls = createInboxPulls({
      run: changed(f, (args) => {
        if (!threadsField(args, "query")?.includes("reviewThreads(first")) return undefined;
        if (threadsField(args, "threadsAfter")) return failing ? 1 : threadPage([thread("t2", { nodes: [noted("t2-1")] })]);
        return threadPage([thread("t1", { nodes: [noted("t1-1")] })], "t100");
      }),
    });
    await pulls.list(repos);
    const partial = await pulls.details(KEY);
    expect(partial.threads_incomplete).toBe(true);
    expect(partial.comments.some((c) => c.body === "t1-1")).toBe(true);
    // The faces it named stay allowed: the commenter's picture is not refused for the part that failed.
    expect(pulls.avatarUrls("github.com").kim).toBe("https://a/kim");
    failing = false;
    const whole = await pulls.details(KEY);
    expect(whole.threads_incomplete).toBeUndefined();
    expect(whole.comments.some((c) => c.body === "t2-1")).toBe(true);
    expect(f.state.views).toBe(2);
  });

  test("a rate limit on the details holds the host, and no read goes out until it lifts; the list's spent budget holds them too", async () => {
    let now = 1_000_000;
    const f = forge();
    const limited = (async (cli: string, args: string[]) => {
      if (isView(args)) {
        f.state.views++;
        return { stdout: "", stderr: "API rate limit exceeded for user", exitCode: 1 };
      }
      return (f.run as unknown as (cli: string, args: string[]) => unknown)(cli, args);
    }) as never;
    const pulls = createInboxPulls({ run: limited, now: () => now });
    await pulls.list(repos);
    await expect(pulls.details(KEY)).rejects.toMatchObject({ code: "pull_details_failed" });
    const views = f.state.views;
    // Held: its own code, and when it lifts, so the window can say until when.
    await expect(pulls.details(KEY)).rejects.toMatchObject({ code: "pull_details_held", message: "github.com asked to slow down.", retryAt: 1_000_000 + 60_000 });
    expect(f.state.views).toBe(views);

    const g = forge();
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const spent = createInboxPulls({
      run: changed(g, (args, stdout) => (args.includes("graphql") && stdout.includes('"authored"') ? { data: { ...JSON.parse(stdout).data, rateLimit: { cost: 1, remaining: 3, resetAt: reset } } } : undefined)),
    });
    await spent.list(repos);
    // GitHub's budget spent: held until it fills, close to an hour here, not a minute.
    await expect(spent.details(KEY)).rejects.toMatchObject({ code: "pull_details_held", retryAt: Date.parse(reset) });
    expect(g.state.views).toBe(0);
  });

  test("a read goes once it is an hour old, and the people it named with it, so the walk stays short", async () => {
    let now = 1_000_000;
    const f = forge();
    const pulls = createInboxPulls({ run: f.run, now: () => now });
    await pulls.list(repos);
    await pulls.details(KEY);
    expect(pulls.avatarUrls("github.com").kim).toBe("https://a/kim");
    now += 59 * 60_000;
    expect(pulls.avatarUrls("github.com").kim).toBe("https://a/kim");
    now += 2 * 60_000;
    expect(pulls.avatarUrls("github.com").kim).toBeUndefined();
  });

  test("two asking at once when the forge fails: both are told it did not answer, neither an internal error", async () => {
    const f = forge();
    f.state.view.exitCode = 1;
    const pulls = createInboxPulls({ run: f.run });
    await pulls.list(repos);
    const answers = await Promise.allSettled([pulls.details(KEY), pulls.details(KEY)]);
    expect(answers.map((a) => (a.status === "rejected" ? (a.reason as { code?: string }).code : "ok"))).toEqual(["pull_details_failed", "pull_details_failed"]);
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
