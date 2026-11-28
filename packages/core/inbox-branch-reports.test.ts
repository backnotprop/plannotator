/**
 * Branch reviews' rules (inbox-branch-reports.ts). What regresses:
 *  - a second report of the same commit counted as new (a second risk run, a second message), or a new commit taken as
 *    the same (the thread never hears of it);
 *  - a report with a field the Inbox can't use (an option-shaped branch, a base equal to the branch) let through;
 *  - a reported branch and its later PR listed as two rows, or a teammate's PR (a fork, another project, a long-lived
 *    branch) claimed into the person's reported branch;
 *  - a reported branch's thread with no review left out of Reviews, or put anywhere but On you;
 *  - a linked machine's report listed under the wrong project;
 *  - a remote URL kept as typed (a password, a query, a fragment) or shown as anything but host and repository;
 *  - HEAD taken as a branch's name;
 *  - a reported branch whose PR merged read as "Ready for review" again;
 *  - a merged PR claimed by a report of other work (a reused branch name, work reported after the merge), hiding it;
 *  - a closed, unmerged PR taking a reported branch out of Reviews;
 *  - a PR merged at a known commit claiming a report of a commit it doesn't hold (a local-only commit after the push);
 *  - a first report made after its PR merged, at the merged commit, read as "Ready for review";
 *  - an old git's report read as a commit gone from the checkout.
 */
import { describe, expect, test } from "bun:test";
import { checkInboxBranchField, INBOX_BRANCH_NAME_NOT_BASE, inboxBranchPlaceWords, inboxBranchReachWords, inboxBranchReportOwners, inboxBranchReportStep, inboxFarBranchReviewRow, type InboxBranchReportRow } from "./inbox-branch-reports";
import { inboxPullStacks, type InboxPull, type InboxPullLink } from "./inbox-pulls";
import { inboxReviewLandingChanges, inboxReviewRows, type InboxReviewStart } from "./inbox-reviews";

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
    expect(checkInboxBranchField({ name: "HEAD" })).toBe(INBOX_BRANCH_NAME_NOT_BASE);
  });

  test("a remote is kept as rebuilt from its parts, never as typed", () => {
    const kept = (remote_url: string) => {
      const field = checkInboxBranchField({ name: "retry-jitter", remote_url });
      return typeof field === "string" ? field : field.remote_url;
    };
    expect(kept("https://bot:s3cret@github.com/northwind/billing-svc.git?token=abc#frag")).toBe("https://github.com/northwind/billing-svc.git");
    expect(kept("https://github.com/northwind/billing-svc")).toBe("https://github.com/northwind/billing-svc.git");
    expect(kept("ssh://git@github.com:22/northwind/billing-svc.git")).toBe("ssh://git@github.com:22/northwind/billing-svc.git");
    for (const hostile of ["ext::sh -c touch% /tmp/x", "file:///etc/passwd", "http://github.com/a/b.git", "git://github.com/a/b.git", "--upload-pack=x", "https://github.com/a/b.git\nmore", "javascript:alert(1)"]) {
      expect(kept(hostile)).toStartWith("branch.remote_url:");
    }
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

  test("once its PR merged, a reported branch's thread reads as merged and leaves Reviews, even after the list stops reading the PR", () => {
    const row = reportRow();
    const merged = pr({ number: 412, state: "merged", merged_at: "2026-11-16T11:00:00.000Z", head_sha: row.head });
    const projects = new Map([[`github.com/${REPO}`, ["prj_billing"]]]);
    const owners = inboxBranchReportOwners([row], [merged], projects);
    expect([...owners.keys()]).toEqual([merged.key]);
    const link: InboxPullLink = { via: "owner", thread_id: row.thread_id, thread_subject: null, project_id: "prj_billing", agent: null, last: null, guide: null };
    const started = new Map([[row.thread_id, startOf(row)]]);
    const { record } = inboxReviewLandingChanges({ threads: [], pulls: [merged], links: { [merged.key]: link }, landed: [] });
    expect(record.map((landing) => [landing.thread_id, landing.state])).toEqual([[row.thread_id, "merged"]]);
    expect(inboxReviewRows({ threads: [], stacks: [], links: { [merged.key]: link }, pulls: [merged], owners, landed: record, started })).toEqual([]);
    // Later the list no longer reads the merged PR: the record still keeps the thread out.
    expect(inboxReviewRows({ threads: [], stacks: [], links: {}, pulls: [], landed: record, started })).toEqual([]);
  });

  test("a merged PR of other work is never claimed: a reused name, or work reported after the merge, stays Ready for review", () => {
    const projects = new Map([[`github.com/${REPO}`, ["prj_billing"]]]);
    // fix-tests merged as #412 last week, at another commit; this report is new work on a new fix-tests.
    const row = reportRow({ branch: "fix-tests", at: "2026-11-16T10:00:00.000Z", head: "b".repeat(40) });
    const old = pr({ number: 412, head: "fix-tests", state: "merged", merged_at: "2026-11-09T10:00:00.000Z", head_sha: "a".repeat(40) });
    expect(inboxBranchReportOwners([row], [old], projects).size).toBe(0);
    const started = new Map([[row.thread_id, startOf(row)]]);
    expect(inboxReviewRows({ threads: [], stacks: [], links: {}, pulls: [old], owners: new Map(), started }).map((r) => r.reason)).toEqual(["branch_ready"]);
    // At the very commit reported, before or after the report: this report's work.
    expect(inboxBranchReportOwners([row], [{ ...old, head_sha: row.head!.slice(0, 12) }], projects).size).toBe(1);
    // Merged commit unknown: only a merge after the latest report is this report's.
    expect(inboxBranchReportOwners([row], [{ ...old, head_sha: null }], projects).size).toBe(0);
    expect(inboxBranchReportOwners([row], [{ ...old, head_sha: null, merged_at: "2026-11-16T12:00:00.000Z" }], projects).size).toBe(1);
  });

  test("a PR merged at a known commit is claimed only when it holds the reported commit, however late it merged", () => {
    const projects = new Map([[`github.com/${REPO}`, ["prj_billing"]]]);
    // H1 pushed and in the PR; the agent then reports H2, a commit only on this computer; the PR merges at H1 later.
    const h1 = "1".repeat(40);
    const row = reportRow({ head: "2".repeat(40), at: "2026-11-16T10:00:00.000Z" });
    const merged = pr({ number: 412, state: "merged", merged_at: "2026-11-16T12:00:00.000Z", head_sha: h1 });
    expect(inboxBranchReportOwners([row], [merged], projects).size).toBe(0);
    expect(inboxBranchReportOwners([row], [merged], projects, () => false).size).toBe(0);
    // Git here says H2 is in what merged (the PR merged at a later commit on top of it): this report's work.
    const asked: [string | null, string][] = [];
    const owners = inboxBranchReportOwners([row], [merged], projects, (report, mergedAt) => {
      asked.push([report.head, mergedAt]);
      return true;
    });
    expect([...owners.keys()]).toEqual([merged.key]);
    expect(asked).toEqual([[row.head, h1]]);
  });

  test("a first report made after its PR merged, at the merged commit, shows no Ready for review row", () => {
    const merged = pr({ number: 412, state: "merged", merged_at: "2026-11-16T09:00:00.000Z" });
    const row = reportRow({ at: "2026-11-16T10:00:00.000Z", head: "3a9f2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f" });
    const atHead = { ...merged, head_sha: row.head!.slice(0, 12) };
    const projects = new Map([[`github.com/${REPO}`, ["prj_billing"]]]);
    const owners = inboxBranchReportOwners([row], [atHead], projects);
    expect([...owners.keys()]).toEqual([atHead.key]);
    const link: InboxPullLink = { via: "owner", thread_id: row.thread_id, thread_subject: null, project_id: "prj_billing", agent: null, last: null, guide: null };
    const { record } = inboxReviewLandingChanges({ threads: [], pulls: [atHead], links: { [atHead.key]: link }, landed: [] });
    expect(record.map((landing) => landing.head_sha)).toEqual([atHead.head_sha]);
    const started = new Map([[row.thread_id, startOf(row)]]);
    expect(inboxReviewRows({ threads: [], stacks: [], links: { [atHead.key]: link }, pulls: [atHead], owners, landed: record, started })).toEqual([]);
    // Later the list no longer reads the PR: the recorded landing still keeps the thread out.
    expect(inboxReviewRows({ threads: [], stacks: [], links: {}, pulls: [], landed: record, started })).toEqual([]);
  });

  test("a closed, unmerged PR is not claimed: the reported branch stays Ready for review", () => {
    const row = reportRow();
    const closed = pr({ number: 413, state: "closed", head_sha: row.head });
    const projects = new Map([[`github.com/${REPO}`, ["prj_billing"]]]);
    expect(inboxBranchReportOwners([row], [closed], projects).size).toBe(0);
    const rows = inboxReviewRows({ threads: [], stacks: [], links: {}, pulls: [closed], owners: new Map(), started: new Map([[row.thread_id, startOf(row)]]) });
    expect(rows.map((r) => [r.id, r.reason])).toEqual([[row.thread_id, "branch_ready"]]);
  });

  test("a report after a landing brings the row back: the landing was earlier work", () => {
    const row = reportRow();
    const merged = pr({ number: 412, state: "merged", merged_at: "2026-11-16T09:00:00.000Z", head_sha: "a".repeat(40) });
    const link: InboxPullLink = { via: "owner", thread_id: row.thread_id, thread_subject: null, project_id: "prj_billing", agent: null, last: null, guide: null };
    const { record } = inboxReviewLandingChanges({ threads: [], pulls: [merged], links: { [merged.key]: link }, landed: [] });
    // Landed before this report (10:00): the row is back, Ready for review.
    const rows = inboxReviewRows({ threads: [], stacks: [], links: {}, pulls: [], landed: record, started: new Map([[row.thread_id, startOf(row)]]) });
    expect(rows.map((r) => [r.id, r.reason])).toEqual([[row.thread_id, "branch_ready"]]);
    // A report from before the landing stays out.
    const earlier = reportRow({ at: "2026-11-16T08:00:00.000Z" });
    expect(inboxReviewRows({ threads: [], stacks: [], links: {}, pulls: [], landed: record, started: new Map([[earlier.thread_id, startOf(earlier)]]) })).toEqual([]);
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
    const cloud = reportRow({ place: "cloud", reachable: false, remote_url: "https://github.com/northwind/billing-svc.git" });
    expect(inboxBranchReachWords(cloud)).toBe("The agent says it pushed it to github.com/northwind/billing-svc. If that is your repository, fetch retry-jitter into the project's checkout here.");
    expect(inboxBranchReachWords({ ...cloud, remote_known: false })).toBe(
      "The agent says it pushed it to github.com/northwind/billing-svc (not the origin of any project here). If that is your repository, fetch retry-jitter into the project's checkout here.",
    );
    // A remote that is no repository's URL (an older or far record) is never shown.
    expect(inboxBranchReachWords({ ...cloud, remote_url: "https://bot:pw@evil.example" })).toBe("This computer doesn't have retry-jitter. Ask the agent to push it, then fetch it here.");
  });

  test("a report this computer's git is too old to read says so, never that the commit left the checkout", () => {
    const old = reportRow({ reachable: false, head: null, git_too_old: true });
    expect(inboxBranchReachWords(old)).toBe("This computer's git is too old to read branches safely.");
    expect(inboxBranchReachWords(reportRow({ reachable: false }))).toContain("isn't in the project's checkout");
  });
});
