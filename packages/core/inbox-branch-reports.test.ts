/**
 * Branch reviews' rules (inbox-branch-reports.ts). What regresses:
 *  - a second report of the same commit counted as new (a second risk run, a second message), or a new commit taken as
 *    the same (the thread never hears of it);
 *  - a report with a field the Inbox can't use (an option-shaped branch, a base equal to the branch) let through;
 *  - a reported branch and its later PR listed as two rows, or a teammate's PR (a fork, another project, a long-lived
 *    branch) claimed into the person's reported branch;
 *  - a reported branch's thread with no review left out of Reviews, or put anywhere but On you;
 *  - a linked machine's report listed under the wrong project.
 */
import { describe, expect, test } from "bun:test";
import { checkInboxBranchField, inboxBranchPlaceWords, inboxBranchReachWords, inboxBranchReportOwners, inboxBranchReportStep, inboxFarBranchReviewRow, type InboxBranchReportRow } from "./inbox-branch-reports";
import { inboxPullStacks, type InboxPull, type InboxPullLink } from "./inbox-pulls";
import { inboxReviewRows, type InboxReviewStart } from "./inbox-reviews";

const REPO = "northwind/billing-svc";

function pr(fields: Partial<InboxPull> & { number: number }): InboxPull {
  return {
    key: `github.com/${REPO}#${fields.number}`,
    platform: "github",
    host: "github.com",
    repo: REPO,
    url: `https://github.com/${REPO}/pull/${fields.number}`,
    title: `PR ${fields.number}`,
    author: "dana",
    mine: true,
    requested: false,
    state: "open",
    base: "main",
    head: "retry-jitter",
    head_repo: REPO,
    additions: 1,
    deletions: 1,
    files: 1,
    review: "review_required",
    approved_by: null,
    reviewers: [],
    checks: "success",
    updated_at: "2026-11-16T09:00:00.000Z",
    merged_at: null,
    ...fields,
  };
}

function reportRow(fields: Partial<InboxBranchReportRow> = {}): InboxBranchReportRow {
  return {
    thread_id: "01JD0000000000000000000000",
    project_id: "prj_billing",
    branch: "retry-jitter",
    base: "main",
    head: "3a9f2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f",
    place: "here",
    remote_url: null,
    summary: "Jitter on retries",
    at: "2026-11-16T10:00:00.000Z",
    reports: 1,
    agent: { host: "claude-code", session: "ses_1", name: "Claude Code" },
    reachable: true,
    risk: null,
    risk_failed: null,
    ...fields,
  };
}

const startOf = (row: InboxBranchReportRow): InboxReviewStart => ({ kind: "branch", changes: "branch", branch: row.branch, base: row.base, ask: "guide", host: "claude-code", project_id: row.project_id, at: row.at, name: "Retry jitter", report: row });

describe("checkInboxBranchField", () => {
  test("takes a branch, its base, head, remote and one line; refuses what git or the Inbox can't use", () => {
    expect(checkInboxBranchField({ name: " retry-jitter ", head: "3A9F2C1", summary: "Jitter\non  retries" })).toEqual({ name: "retry-jitter", head: "3a9f2c1", summary: "Jitter on retries" });
    expect(checkInboxBranchField({ name: "retry-jitter", remote_url: "git@github.com:northwind/billing-svc.git" })).toEqual({ name: "retry-jitter", remote_url: "git@github.com:northwind/billing-svc.git" });
    expect(checkInboxBranchField({ name: "-delete" })).toStartWith("branch.name:");
    expect(checkInboxBranchField({ name: "retry-jitter", base: "retry-jitter" })).toStartWith("branch.base:");
    expect(checkInboxBranchField({ name: "retry-jitter", head: "not-a-sha" })).toStartWith("branch.head:");
    expect(checkInboxBranchField({ name: "retry-jitter", remote_url: "file:///tmp/x" })).toStartWith("branch.remote_url:");
    expect(checkInboxBranchField({ name: "retry-jitter", folder: "/tmp" })).toStartWith("branch.folder:");
    expect(checkInboxBranchField("retry-jitter")).toStartWith("branch:");
  });
});

describe("inboxBranchReportStep: one thread per branch, idempotent per head", () => {
  test("the first report is new; the same commit again (in full or short) is the same; another commit updates", () => {
    const full = "3a9f2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f";
    expect(inboxBranchReportStep(null, full)).toBe("new");
    expect(inboxBranchReportStep({ head: full }, full)).toBe("same");
    expect(inboxBranchReportStep({ head: full }, "3a9f2c1")).toBe("same");
    expect(inboxBranchReportStep({ head: "3a9f2c1" }, full)).toBe("same");
    expect(inboxBranchReportStep({ head: full }, "b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8")).toBe("update");
    // A head nobody could read is never taken for the same one.
    expect(inboxBranchReportStep({ head: null }, null)).toBe("update");
  });
});

describe("one thread from report to PR", () => {
  test("the person's own PR on the reported branch is owned by the report's thread: one row, the PR on it", () => {
    const row = reportRow();
    const pull = pr({ number: 412 });
    const projects = new Map([[`github.com/${REPO}`, ["prj_billing"]]]);
    const owners = inboxBranchReportOwners([row], [pull], projects);
    expect([...owners]).toEqual([[pull.key, { thread_id: row.thread_id }]]);
    const link: InboxPullLink = { via: "owner", thread_id: row.thread_id, thread_subject: null, project_id: "prj_billing", agent: null, last: null, guide: null };
    const rows = inboxReviewRows({ threads: [], stacks: inboxPullStacks([pull]), links: { [pull.key]: link }, owners, started: new Map([[row.thread_id, startOf(row)]]) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: row.thread_id, reviewed: true, thread_id: row.thread_id, pull_keys: [pull.key], move: "on_you", reason: "branch_ready" });
  });

  test("a teammate's PR, a fork's, another project's or a long-lived branch's is never claimed", () => {
    const projects = new Map([[`github.com/${REPO}`, ["prj_billing"]]]);
    const theirs = pr({ number: 1, mine: false, author: "tomas" });
    const fork = pr({ number: 2, head_repo: "tomas/billing-svc" });
    const other = pr({ number: 3, repo: "northwind/web", key: "github.com/northwind/web#3" });
    expect(inboxBranchReportOwners([reportRow()], [theirs, fork, other], projects).size).toBe(0);
    expect(inboxBranchReportOwners([reportRow({ branch: "main" })], [pr({ number: 4, head: "main" })], projects).size).toBe(0);
    expect(inboxBranchReportOwners([reportRow({ project_id: "prj_other" })], [pr({ number: 5 })], projects).size).toBe(0);
  });

  test("a reported branch with no review and no PR is On you, and keeps its row with its agent ended", () => {
    const row = reportRow();
    const rows = inboxReviewRows({ threads: [], stacks: [], links: {}, started: new Map([[row.thread_id, startOf(row)]]), ended: () => true });
    expect(rows.map((r) => [r.id, r.move, r.reason])).toEqual([[row.thread_id, "on_you", "branch_ready"]]);
  });
});

describe("a linked machine's report", () => {
  test("is a row under that machine's project, marked with that machine, opened in its own thread", () => {
    const far = reportRow({ project_id: "prj_on_b", machine: { id: "ibx_01JD0000000000000000000001", name: "Mac mini" }, reachable: false });
    const row = inboxFarBranchReviewRow(far);
    expect(row).toMatchObject({ id: far.thread_id, thread_id: far.thread_id, move: "on_you", reason: "branch_ready", started: { kind: "branch", project_id: "prj_on_b" } });
    expect(inboxBranchPlaceWords(far)).toBe("Branch on Mac mini");
    expect(inboxBranchReachWords(far)).toContain("Mac mini");
  });

  test("a local branch the checkout has reads as nothing needed; a cloud agent's not fetched says so", () => {
    expect(inboxBranchReachWords(reportRow())).toBeNull();
    expect(inboxBranchPlaceWords(reportRow({ place: "cloud" }))).toBe("Cloud agent’s branch");
    expect(inboxBranchReachWords(reportRow({ place: "cloud", reachable: false, remote_url: "https://github.com/northwind/billing-svc.git" }))).toContain("Fetch it from https://github.com/northwind/billing-svc.git");
  });
});
