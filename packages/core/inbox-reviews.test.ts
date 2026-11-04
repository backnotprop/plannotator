/**
 * Reviews in the Inbox: whose move a review is, and the rows. What regresses:
 *  - a review waiting on the person not On you, or still On you after they
 *    sent feedback or approved (the audit's "an approved linked PR stays On
 *    you": the pulls rule alone keeps it there);
 *  - an approval read from an older answer once the person wrote again;
 *  - an approved review shown Ready to land while the forge still holds the
 *    person's PR (changes asked, checks failing or running);
 *  - a teammate's PR put in Ready to land, or its review request lost from On you;
 *  - a review thread listed twice (once as a thread, once as its PR), a PR the
 *    person handed over shown as not reviewed, or a listed PR shown as reviewed;
 *  - an archived review thread listed with no open PR left;
 *  - a source field that an agent made multi-line or unbounded.
 */
import { describe, expect, test } from "bun:test";
import { inboxPullMove, inboxPullStacks, type InboxPull, type InboxPullLink } from "./inbox-pulls";
import { INBOX_REVIEW_SOURCE_FIELD_MAX, inboxReviewGroups, inboxReviewMove, inboxReviewRows, inboxReviewSourceOf, type InboxReviewThread } from "./inbox-reviews";

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
    // The person wrote again after approving ("one more thing"): the agent has it.
    expect(inboxReviewMove(review({ thread_id: "t", ...approved("t"), answered: { message_id: "later", at: "2026-11-04T12:00:00.000Z" } }))).toEqual({
      move: "agents",
      reason: "feedback_sent",
    });
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
      threads: [review({ thread_id: "t_review" }), review({ thread_id: "t_local", source: { kind: "local" } })],
      stacks,
      // The agent's own thread names #413; #875 was handed to a thread whose review has not arrived.
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
    const threads = [review({ thread_id: "t_done", resolved_at: "2026-11-04T12:00:00.000Z" }), review({ thread_id: "t_pr", resolved_at: "2026-11-04T12:00:00.000Z" })];
    const rows = inboxReviewRows({ threads, stacks: inboxPullStacks([pull]), links: { [pull.key]: link("t_pr") } });
    expect(rows.map((r) => r.id)).toEqual(["t_pr"]);
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
