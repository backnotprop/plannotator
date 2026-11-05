/**
 * Reviews in the Inbox: whose move a review is, and the rows. What regresses:
 *  - a review waiting on the person not On you, or still On you after they
 *    sent feedback or approved (the audit's "an approved linked PR stays On
 *    you": the pulls rule alone keeps it there);
 *  - an approval lost once the person writes again ("Thanks!"), sticking the
 *    row in With your agents;
 *  - an approved review shown Ready to land while the forge still holds the
 *    person's PR (changes asked, checks failing or running);
 *  - a teammate's PR put in Ready to land, or its review request lost from On you;
 *  - a review thread listed twice (once as a thread, once as its PR), a PR the
 *    person handed over shown as not reviewed, or a listed PR shown as reviewed;
 *  - an archived review thread listed with no open PR left, or a review sent
 *    after the archive (the Inbox brings the thread back) hidden;
 *  - a review whose PR merged still listed as Ready to land or On you, or a
 *    newer review sent after the merge hidden;
 *  - a teammate's PR (a fork's, or on a long-lived branch) claimed by branch
 *    into the person's local review, hiding its row or the review;
 *  - a PR merely mentioned in a review thread claimed into its row, hiding a
 *    teammate's "asked for your review" row;
 *  - a source field that an agent made multi-line or unbounded.
 */
import { describe, expect, test } from "bun:test";
import { inboxPullMove, inboxPullStacks, type InboxPull, type InboxPullLink } from "./inbox-pulls";
import { INBOX_REVIEW_SOURCE_FIELD_MAX, inboxReviewGroups, inboxReviewIsOf, inboxReviewLandingChanges, inboxReviewLandingOf, inboxReviewMove, inboxReviewRows, inboxReviewSourceOf, type InboxReviewLanding, type InboxReviewThread } from "./inbox-reviews";

function pr(fields: Partial<InboxPull> & { number: number }): InboxPull {
  const repo = "northwind/billing-svc";
  return {
    key: `github.com/${repo}#${fields.number}`,
    platform: "github",
    host: "github.com",
    repo,
    url: `https://github.com/${repo}/pull/${fields.number}`,
    title: `PR ${fields.number}`,
    author: "dana",
    mine: true,
    requested: false,
    state: "open",
    base: "main",
    head: `branch-${fields.number}`,
    head_repo: repo,
    additions: 1,
    deletions: 1,
    files: 1,
    review: "review_required",
    approved_by: null,
    reviewers: [],
    checks: "success",
    updated_at: "2026-11-04T09:00:00.000Z",
    merged_at: null,
    ...fields,
  };
}

function review(fields: Partial<InboxReviewThread> & { thread_id: string }): InboxReviewThread {
  return {
    project_id: "prj_1",
    subject: "Retry worker cleanup",
    first_review_id: `${fields.thread_id}_r1`,
    latest_review_id: `${fields.thread_id}_r1`,
    round: 1,
    title: "Retry failed charges",
    files: 5,
    additions: 115,
    deletions: 1,
    agent: { host: "claude-code", session: "ses_1", name: "Claude Code" },
    source: { kind: "local", branch: "retry-jitter", base: "main" },
    verdict: null,
    answered: null,
    reviewed_at: "2026-11-04T10:00:00.000Z",
    updated_at: "2026-11-04T10:00:00.000Z",
    resolved_at: null,
    ...fields,
  };
}

const approved = (thread: string, at = "2026-11-04T11:00:00.000Z") => ({
  verdict: { verdict: "approved" as const, comments: 0, message_id: `${thread}_v`, at },
  answered: { message_id: `${thread}_v`, at },
});
const changes = (thread: string) => ({
  verdict: { verdict: "changes_requested" as const, comments: 3, message_id: `${thread}_v`, at: "2026-11-04T11:00:00.000Z" },
  answered: { message_id: `${thread}_v`, at: "2026-11-04T11:00:00.000Z" },
});

function link(threadId: string, via: InboxPullLink["via"] = "url"): InboxPullLink {
  return { via, thread_id: threadId, thread_subject: null, project_id: "prj_1", agent: null, last: null, guide: null };
}

describe("inboxReviewMove", () => {
  test("the person's answer moves a local review: waiting on them, feedback sent, approved", () => {
    expect(inboxReviewMove(review({ thread_id: "t" }))).toEqual({ move: "on_you", reason: "review_ready" });
    expect(inboxReviewMove(review({ thread_id: "t", ...changes("t") }))).toEqual({ move: "agents", reason: "feedback_sent" });
    // Comments or words sent without a verdict are feedback too.
    expect(inboxReviewMove(review({ thread_id: "t", answered: { message_id: "m", at: "2026-11-04T11:00:00.000Z" } }))).toEqual({ move: "agents", reason: "feedback_sent" });
    expect(inboxReviewMove(review({ thread_id: "t", ...approved("t") }))).toEqual({ move: "ready", reason: "approved" });
    // The person wrote again after approving ("Thanks!", a yes to the agent): the verdict still decides.
    const chat = { message_id: "later", at: "2026-11-04T12:00:00.000Z" };
    expect(inboxReviewMove(review({ thread_id: "t", ...approved("t"), answered: chat }))).toEqual({ move: "ready", reason: "approved" });
    expect(inboxReviewMove(review({ thread_id: "t", ...approved("t"), answered: chat }), [pr({ number: 9, checks: "failure" })])).toEqual({ move: "on_you", reason: "failing" });
    expect(inboxReviewMove(review({ thread_id: "t", ...changes("t"), answered: chat }))).toEqual({ move: "agents", reason: "feedback_sent" });
  });

  test("an approved review of the person's linked PR leaves On you, where the pulls rule alone keeps it", () => {
    const pull = pr({ number: 412 });
    // The audit's finding: linked and checks done is On you whatever the person answered.
    expect(inboxPullMove(pull, true).move).toBe("on_you");
    expect(inboxReviewMove(review({ thread_id: "t" }), [pull]).move).toBe("on_you");
    expect(inboxReviewMove(review({ thread_id: "t", ...approved("t") }), [pull])).toEqual({ move: "ready", reason: "approved" });
  });

  test("after an approval the forge can still hold the person's own PR", () => {
    const a = review({ thread_id: "t", ...approved("t") });
    expect(inboxReviewMove(a, [pr({ number: 1, review: "changes_requested" })])).toEqual({ move: "on_you", reason: "changes" });
    expect(inboxReviewMove(a, [pr({ number: 2, checks: "failure" })])).toEqual({ move: "on_you", reason: "failing" });
    expect(inboxReviewMove(a, [pr({ number: 3, checks: "pending" })])).toEqual({ move: "waiting", reason: "checks_running" });
    expect(inboxReviewMove(a, [pr({ number: 4, state: "draft" })])).toEqual({ move: "waiting", reason: "draft" });
    expect(inboxReviewMove(a, [pr({ number: 5, reviewers: ["jun"] })])).toEqual({ move: "waiting", reason: "forge_review" });
    // A merged layer under the stack holds nothing.
    expect(inboxReviewMove(a, [pr({ number: 6, state: "merged", checks: "failure" }), pr({ number: 7 })])).toEqual({ move: "ready", reason: "approved" });
  });

  test("a teammate's PR is never Ready to land: answered, it is On you while their review is asked of the person", () => {
    const theirs = pr({ number: 880, mine: false, author: "tomas" });
    expect(inboxReviewMove(review({ thread_id: "t" }), [theirs])).toEqual({ move: "on_you", reason: "review_ready" });
    expect(inboxReviewMove(review({ thread_id: "t", answered: { message_id: "m", at: "x" } }), [theirs])).toEqual({ move: "waiting", reason: "others" });
    expect(inboxReviewMove(review({ thread_id: "t", answered: { message_id: "m", at: "x" } }), [{ ...theirs, requested: true }])).toEqual({ move: "on_you", reason: "requested" });
  });

  test("a PR handed to an agent with no review yet is with the agents", () => {
    expect(inboxReviewMove(null, [pr({ number: 1 })])).toEqual({ move: "agents", reason: "curating" });
  });
});

describe("inboxReviewRows", () => {
  test("one row per review thread, its PRs attached; listed PRs are rows of their own, not reviewed", () => {
    const low = pr({ number: 412, head: "retry/schedule" });
    const top = pr({ number: 413, head: "retry/backoff", base: "retry/schedule" });
    const theirs = pr({ number: 880, mine: false, requested: true, author: "tomas" });
    const lone = pr({ number: 869 });
    const handed = pr({ number: 875 });
    const stacks = inboxPullStacks([low, top, theirs, lone, handed]);
    const rows = inboxReviewRows({
      threads: [review({ thread_id: "t_review", source: { kind: "pr", pr: { url: top.url } } }), review({ thread_id: "t_local", source: { kind: "local" } })],
      stacks,
      // The agent's own thread names #413 and reviewed it; #875 was handed to a thread whose review has not arrived.
      links: { [top.key]: link("t_review"), [handed.key]: link("t_handed", "owner") },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(rows).toHaveLength(5);
    // The stack is under its review thread, once: no row of its own.
    expect(byId.get("t_review")).toMatchObject({ reviewed: true, thread_id: "t_review", pull_keys: [top.key], move: "on_you", reason: "review_ready" });
    expect(byId.get("t_review")!.stacks.map((s) => s.id)).toEqual([top.key]);
    expect(rows.some((row) => !row.reviewed && row.stacks[0]?.layers.some((l) => l.key === low.key))).toBe(false);
    expect(byId.get("t_local")).toMatchObject({ reviewed: true, stacks: [], move: "on_you" });
    expect(byId.get("t_handed")).toMatchObject({ reviewed: true, review: null, move: "agents", reason: "curating", pull_keys: [handed.key] });
    expect(byId.get(lone.key)).toMatchObject({ reviewed: false, thread_id: null, move: "not_reviewed" });
    // A teammate's review request stays On you, not reviewed.
    expect(byId.get(theirs.key)).toMatchObject({ reviewed: false, move: "on_you", reason: "requested" });
  });

  test("a URL link to a thread with no review leaves the PR not reviewed, naming that thread", () => {
    const pull = pr({ number: 412 });
    const [row] = inboxReviewRows({ threads: [], stacks: inboxPullStacks([pull]), links: { [pull.key]: link("t_agent") } });
    expect(row).toMatchObject({ reviewed: false, thread_id: "t_agent", move: "not_reviewed" });
  });

  test("an archived review thread leaves Reviews unless it still owns an open PR", () => {
    const pull = pr({ number: 412 });
    const threads = [
      review({ thread_id: "t_done", resolved_at: "2026-11-04T12:00:00.000Z" }),
      review({ thread_id: "t_pr", resolved_at: "2026-11-04T12:00:00.000Z", source: { kind: "pr", pr: { url: pull.url } } }),
    ];
    const rows = inboxReviewRows({ threads, stacks: inboxPullStacks([pull]), links: { [pull.key]: link("t_pr") } });
    expect(rows.map((r) => r.id)).toEqual(["t_pr"]);
  });

  test("a review sent after the archive brings the thread back to Reviews, as the Inbox brings it back", () => {
    const back = review({ thread_id: "t_back", round: 2, latest_review_id: "t_back_r2", reviewed_at: "2026-11-04T13:00:00.000Z", updated_at: "2026-11-04T13:00:00.000Z", resolved_at: "2026-11-04T12:00:00.000Z" });
    const rows = inboxReviewRows({ threads: [back], stacks: [], links: {} });
    expect(rows.map((r) => [r.id, r.move])).toEqual([["t_back", "on_you"]]);
  });

  test("a review whose PR landed leaves Reviews, answered or not; an open stack layer above it stays a row", () => {
    const merged = pr({ number: 412, head: "retry/schedule", state: "merged", merged_at: "2026-11-04T12:00:00.000Z" });
    const open = pr({ number: 413, head: "retry/backoff", base: "retry/schedule" });
    const lone = pr({ number: 500, head: "docs", state: "merged", merged_at: "2026-11-04T12:00:00.000Z" });
    const threads = [
      review({ thread_id: "t_stack", source: { kind: "pr", pr: { url: merged.url } }, ...approved("t_stack") }),
      review({ thread_id: "t_lone", source: { kind: "pr", pr: { url: lone.url } } }),
    ];
    // The list keeps merged PRs (`pulls`); a merged PR under no open stack is in no stack.
    const rows = inboxReviewRows({
      threads,
      pulls: [merged, open, lone],
      stacks: inboxPullStacks([merged, open, lone]),
      links: { [merged.key]: link("t_stack"), [lone.key]: link("t_lone", "owner") },
    });
    expect(rows.map((r) => [r.id, r.reviewed])).toEqual([[open.key, false]]);
  });

  test("a review newer than its thread's merged PR stays: round 2 after the merge waits on the person", () => {
    const merged = pr({ number: 10, head: "feature", state: "merged", merged_at: "2026-11-04T11:00:00.000Z" });
    const round2 = review({ thread_id: "t", round: 2, latest_review_id: "t_r2", reviewed_at: "2026-11-04T12:00:00.000Z", updated_at: "2026-11-04T12:00:00.000Z" });
    const rows = inboxReviewRows({ threads: [round2], pulls: [merged], stacks: inboxPullStacks([merged]), links: { [merged.key]: link("t", "owner") } });
    expect(rows.map((r) => [r.id, r.move, r.pull_keys])).toEqual([["t", "on_you", []]]);
  });

  test("a teammate's fork PR on the review's branch is not the review's (B1): it keeps its own row", () => {
    const fork = pr({ number: 77, head: "main", head_repo: "tomas/billing-svc", mine: false, author: "tomas" });
    const rows = inboxReviewRows({
      // A local review of `main`, approved, in a thread that names #77.
      threads: [review({ thread_id: "t", source: { kind: "local", branch: "main", repo: "billing-svc" }, ...approved("t") })],
      stacks: inboxPullStacks([fork]),
      links: { [fork.key]: link("t") },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("t")).toMatchObject({ move: "ready", reason: "approved", pull_keys: [] });
    expect(byId.get(fork.key)).toMatchObject({ reviewed: false, move: "not_reviewed" });
  });

  test("a teammate's merged fork PR on the review's branch does not hide the person's own review (B2)", () => {
    const fork = pr({ number: 78, head: "patch-1", head_repo: "tomas/billing-svc", mine: false, state: "merged", merged_at: "2026-11-04T12:00:00.000Z" });
    const rows = inboxReviewRows({
      threads: [review({ thread_id: "t", source: { kind: "local", branch: "patch-1" } })],
      pulls: [fork],
      stacks: inboxPullStacks([fork]),
      links: { [fork.key]: link("t") },
    });
    expect(rows.map((r) => [r.id, r.move])).toEqual([["t", "on_you"]]);
  });

  test("the branch rule: only the person's own PR, from the repository itself, never a long-lived branch", () => {
    const own = { kind: "local" as const, branch: "retry-jitter" };
    expect(inboxReviewIsOf(own, pr({ number: 1, head: "retry-jitter" }))).toBe(true);
    expect(inboxReviewIsOf(own, pr({ number: 2, head: "retry-jitter", mine: false }))).toBe(false);
    expect(inboxReviewIsOf(own, pr({ number: 3, head: "retry-jitter", head_repo: "dana/billing-svc" }))).toBe(false);
    expect(inboxReviewIsOf({ kind: "local", branch: "main" }, pr({ number: 4, head: "main" }))).toBe(false);
    // Naming the PR itself still matches whoever wrote it.
    expect(inboxReviewIsOf({ kind: "pr", pr: { url: "https://github.com/northwind/billing-svc/pull/5" } }, pr({ number: 5, mine: false }))).toBe(true);
  });

  test("a PR merely mentioned in a review thread is not claimed; one the review is of, or handed over, is", () => {
    const theirs = pr({ number: 880, mine: false, requested: true, author: "tomas", head: "rtl" });
    const mine = pr({ number: 412, head: "retry-jitter" });
    const handed = pr({ number: 413, head: "other" });
    const rows = inboxReviewRows({
      // A local review of branch retry-jitter whose thread also names tomas's PR.
      threads: [review({ thread_id: "t_local" }), review({ thread_id: "t_handed", source: { kind: "local", branch: "elsewhere" } })],
      stacks: inboxPullStacks([theirs, mine, handed]),
      links: { [theirs.key]: link("t_local"), [mine.key]: link("t_local"), [handed.key]: link("t_handed", "owner") },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(theirs.key)).toMatchObject({ reviewed: false, move: "on_you", reason: "requested" });
    // The review's branch is #412's head: that PR is the review's.
    expect(byId.get("t_local")!.pull_keys).toEqual([mine.key]);
    expect(byId.get("t_handed")!.pull_keys).toEqual([handed.key]);
    expect(rows).toHaveLength(3);
  });

  test("a verdict moves the row between groups", () => {
    const groupOf = (thread: InboxReviewThread) => {
      const groups = inboxReviewGroups(inboxReviewRows({ threads: [thread], stacks: [], links: {} }));
      return Object.entries(groups).find(([, rows]) => rows.length > 0)![0];
    };
    expect(groupOf(review({ thread_id: "t" }))).toBe("on_you");
    expect(groupOf(review({ thread_id: "t", ...changes("t") }))).toBe("agents");
    // Round 2 arrives: the earlier verdict no longer answers it.
    expect(groupOf(review({ thread_id: "t", round: 2, latest_review_id: "t_r2" }))).toBe("on_you");
    expect(groupOf(review({ thread_id: "t", round: 2, latest_review_id: "t_r2", ...approved("t") }))).toBe("ready");
  });
});

describe("inboxReviewSourceOf", () => {
  test("keeps the snapshot's source and base, each on one bounded line; an unknown kind is no source", () => {
    const source = inboxReviewSourceOf({
      source: { kind: "pr", repo: "northwind/billing-svc", branch: "retry\nschedule", headSha: "abc", pr: { url: "https://github.com/northwind/billing-svc/pull/412", number: 412, platform: "github" } },
      review: { gitRef: "PR #412", base: "x".repeat(1000) },
    });
    expect(source).toMatchObject({ kind: "pr", repo: "northwind/billing-svc", branch: "retry schedule", git_ref: "PR #412", head_sha: "abc", pr: { number: 412, platform: "github" } });
    expect(source!.base!.length).toBe(INBOX_REVIEW_SOURCE_FIELD_MAX);
    expect(inboxReviewSourceOf({ source: { kind: "pr", pr: { url: "javascript:alert(1)" } } })!.pr).toBeUndefined();
    expect(inboxReviewSourceOf({ source: { kind: "elsewhere" } })).toBeNull();
  });
});

describe("a teammate's PR assigned to the person", () => {
  test("is on them, as a request is; a request's own words win", () => {
    const assigned = pr({ number: 1, mine: false, assigned: true });
    const rows = (p: InboxPull) => inboxReviewRows({ threads: [], stacks: inboxPullStacks([p]), links: {}, pulls: [p] });
    expect(rows(assigned).map((r) => [r.move, r.reason])).toEqual([["on_you", "assigned"]]);
    expect(rows({ ...assigned, requested: true }).map((r) => r.reason)).toEqual(["requested"]);
    expect(rows({ ...assigned, assigned: false }).map((r) => r.move)).toEqual(["not_reviewed"]);
  });
});

describe("landed PRs", () => {
  const MERGED_AT = "2026-11-04T12:00:00.000Z";
  const merged = () => pr({ number: 10, head: "feature", state: "merged", merged_at: MERGED_AT });
  const landing = (fields: Partial<InboxReviewLanding> = {}): InboxReviewLanding => ({
    key: "github.com/northwind/billing-svc#10",
    thread_id: "t",
    state: "merged",
    at: MERGED_AT,
    url: "https://github.com/northwind/billing-svc/pull/10",
    number: 10,
    title: "PR 10",
    platform: "github",
    head: "feature",
    through_review: "t_r1",
    ...fields,
  });

  test("past the list's window the record still takes the thread out of Reviews, where it would read as a local review", () => {
    const thread = review({ thread_id: "t", source: { kind: "pr", pr: { url: landing().url } } });
    expect(inboxReviewRows({ threads: [thread], stacks: [], links: {}, pulls: [] })).toHaveLength(1);
    expect(inboxReviewRows({ threads: [thread], stacks: [], links: {}, pulls: [], landed: [landing()] })).toEqual([]);
  });

  test("a closed PR leaves too, and a later review comes back with a link to the PR", () => {
    const closed = landing({ state: "closed" });
    const round2 = review({ thread_id: "t", round: 2, latest_review_id: "t_r2" });
    const rows = inboxReviewRows({ threads: [round2], stacks: [], links: {}, pulls: [], landed: [closed] });
    expect(rows.map((r) => [r.id, r.move, r.landed.map((l) => [l.state, l.url])])).toEqual([["t", "on_you", [["closed", closed.url]]]]);
  });

  test("a later review the person approved has nothing left to land: it never reads Ready to land", () => {
    const round2 = review({ thread_id: "t", round: 2, latest_review_id: "t_r2", source: { kind: "pr", pr: { url: landing().url } }, ...approved("t") });
    expect(inboxReviewRows({ threads: [round2], stacks: [], links: {}, pulls: [], landed: [landing()] })).toEqual([]);
  });

  test("a clock a few minutes fast does not make a review sent before the merge look newer; a later one by an hour is", () => {
    const of = (reviewedAt: string) => inboxReviewLandingOf(landing(), "t", { latest_review_id: "t_r1", reviewed_at: reviewedAt });
    expect(of("2026-11-04T12:03:00.000Z").through_review).toBe("t_r1");
    expect(of("2026-11-04T13:00:00.000Z").through_review).toBeNull();
  });

  test("the record compares reviews by id: a new review counts however the clocks disagree", () => {
    // By this machine's clock the new review is older than the merge.
    const thread = review({ thread_id: "t", round: 2, latest_review_id: "t_r2", reviewed_at: "2026-11-04T11:00:00.000Z" });
    expect(inboxReviewRows({ threads: [thread], stacks: [], links: {}, pulls: [], landed: [landing()] }).map((r) => r.id)).toEqual(["t"]);
  });

  test("a PR seen merged is recorded once, against the review it was first seen with; seen open again it is forgotten", () => {
    const threads = [review({ thread_id: "t" })];
    const pull = merged();
    const links = { [pull.key]: link("t", "owner") };
    const first = inboxReviewLandingChanges({ threads, pulls: [pull], links, landed: [] });
    expect(first.record.map((l) => [l.key, l.thread_id, l.through_review])).toEqual([[pull.key, "t", "t_r1"]]);
    expect(inboxReviewLandingChanges({ threads: [review({ thread_id: "t", latest_review_id: "t_r2" })], pulls: [pull], links, landed: first.record }).record).toEqual([]);
    const reopened = pr({ number: 10, head: "feature" });
    expect(inboxReviewLandingChanges({ threads, pulls: [reopened], links, landed: first.record }).forget).toEqual([pull.key]);
  });

  test("a thread with a PR off the list and no record stays: it may be open (a teammate's stack, its bottom merged)", () => {
    const owners = new Map([[landing().key, { thread_id: "t" }], ["github.com/northwind/billing-svc#999", { thread_id: "t" }]]);
    const rows = inboxReviewRows({ threads: [review({ thread_id: "t" })], stacks: [], links: {}, pulls: [], landed: [landing()], owners });
    expect(rows.map((r) => r.id)).toEqual(["t"]);
    expect(inboxReviewRows({ threads: [review({ thread_id: "t" })], stacks: [], links: {}, pulls: [], landed: [landing(), landing({ key: "github.com/northwind/billing-svc#999", number: 999 })], owners })).toEqual([]);
  });

  test("two threads on one PR each get a record, against their own review", () => {
    const pull = merged();
    const first = inboxReviewLandingChanges({ threads: [review({ thread_id: "a", source: { kind: "pr", pr: { url: pull.url } } })], pulls: [pull], links: { [pull.key]: link("a") }, landed: [] }).record;
    const second = inboxReviewLandingChanges({ threads: [review({ thread_id: "b", source: { kind: "pr", pr: { url: pull.url } } })], pulls: [pull], links: { [pull.key]: link("b") }, landed: first }).record;
    expect(second.map((l) => l.thread_id)).toEqual(["b"]);
  });

  test("an approved local review on another branch, in a thread with an old landing, reads Ready to land", () => {
    const local = review({ thread_id: "t", latest_review_id: "t_r2", source: { kind: "local", branch: "other" }, ...approved("t") });
    expect(inboxReviewRows({ threads: [local], stacks: [], links: {}, pulls: [], landed: [landing()] }).map((r) => [r.id, r.move])).toEqual([["t", "ready"]]);
    const ofIt = review({ thread_id: "t", latest_review_id: "t_r2", source: { kind: "local", branch: "feature" }, ...approved("t") });
    expect(inboxReviewRows({ threads: [ofIt], stacks: [], links: {}, pulls: [], landed: [landing()] })).toEqual([]);
  });

  test("a reopened PR's record no longer hides its thread", () => {
    const open = pr({ number: 10, head: "feature" });
    const rows = inboxReviewRows({ threads: [review({ thread_id: "t" })], stacks: inboxPullStacks([open]), links: { [open.key]: link("t", "owner") }, pulls: [open], landed: [landing()] });
    expect(rows.map((r) => r.id)).toEqual(["t"]);
  });
});

