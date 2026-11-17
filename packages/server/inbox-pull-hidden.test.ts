/**
 * Hidden pull requests on the machine whose window hid them (inbox-pull-hidden.ts). What regresses: a hide lost across
 * a restart or readable by others, a PR that merged or closed kept hidden forever (or an open one forgotten), a hidden
 * PR still listed, a write that is no PR (a link that is not https), the records growing without end, and a review
 * thread's row left in Reviews with no PR because its PRs are hidden (or a local review taken away with it).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxPull, InboxReviewRow } from "@plannotator/core/inbox-types";
import { createInboxPullHidden, INBOX_PULL_HIDDEN_FILE, PULL_HIDDEN_KEPT, pullHiddenBodyOf, reviewRowsShown } from "./inbox-pull-hidden";

// Under the run's own data folder when it has one (the sandbox), else the system's temp folder.
const scratch = () => mkdtempSync(join(process.env.PLANNOTATOR_DATA_DIR || tmpdir(), "plannotator-pull-hidden-"));

const KEY = "github.com/northwind/api#7";
const pull = (number: number, over: Partial<InboxPull> = {}): InboxPull =>
  ({ key: `github.com/northwind/api#${number}`, platform: "github", host: "github.com", repo: "northwind/api", number, url: `https://github.com/northwind/api/pull/${number}`, title: `PR ${number}`, author: "jun", mine: false, requested: true, state: "open", base: "main", head: `b${number}`, head_repo: "northwind/api", additions: 1, deletions: 1, files: 1, review: null, approved_by: null, reviewers: [], checks: null, updated_at: "2026-11-14T10:00:00Z", merged_at: null, ...over }) as InboxPull;
const hide = (number: number) => ({ key: `github.com/northwind/api#${number}`, title: `PR ${number}`, url: `https://github.com/northwind/api/pull/${number}` });

describe("the PRs a machine keeps hidden", () => {
  test("a hide is kept 0600 across a restart; hiding it again keeps its first time; Show again takes it out", () => {
    const dataDir = scratch();
    const hidden = createInboxPullHidden(dataDir);
    expect(hidden.change({ hide: [hide(7)], show: [] }, new Date("2026-11-17T10:00:00Z"))).toEqual([{ ...hide(7), at: "2026-11-17T10:00:00.000Z" }]);
    hidden.change({ hide: [hide(7)], show: [] }, new Date("2026-11-17T11:00:00Z"));
    const file = join(dataDir, "inbox", INBOX_PULL_HIDDEN_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = createInboxPullHidden(dataDir);
    expect(again.list()).toEqual([{ ...hide(7), at: "2026-11-17T10:00:00.000Z" }]);
    expect(again.change({ hide: [], show: [KEY] }, new Date())).toEqual([]);
    expect(createInboxPullHidden(dataDir).has(KEY)).toBe(false);
  });

  test("a hidden PR leaves the list; the newest hidden comes first", () => {
    const hidden = createInboxPullHidden(scratch());
    hidden.change({ hide: [hide(7)], show: [] }, new Date("2026-11-17T10:00:00Z"));
    hidden.change({ hide: [hide(9)], show: [] }, new Date("2026-11-17T11:00:00Z"));
    expect(hidden.shown([pull(7), pull(8), pull(9)]).map((p) => p.number)).toEqual([8]);
    expect(hidden.list().map((h) => h.key)).toEqual([pull(9).key, pull(7).key]);
  });

  test("a read that sees it merged or closed forgets it; one that sees it open (new activity) keeps it hidden", () => {
    const hidden = createInboxPullHidden(scratch());
    hidden.change({ hide: [hide(7), hide(8), hide(9)], show: [] }, new Date());
    hidden.settle([pull(7, { state: "merged" }), pull(8, { state: "closed" }), pull(9, { updated_at: "2026-11-18T10:00:00Z", review: "changes_requested" })]);
    expect(hidden.list().map((h) => h.key)).toEqual([pull(9).key]);
  });

  test("the board's whole read that no longer lists it (closed) forgets it; a host that did not answer whole keeps it", () => {
    const hidden = createInboxPullHidden(scratch());
    hidden.change({ hide: [hide(7), hide(8), { key: "gitlab.com/northwind/data#3:pull", title: "MR 3", url: "https://gitlab.com/northwind/data/-/merge_requests/3" }], show: [] }, new Date());
    const github = { cli: "gh" as const, host: "github.com", login: "dana" };
    hidden.forgetGone([pull(8)], [{ ...github, others_pending: true }]);
    hidden.forgetGone([pull(8)], [{ ...github, capped: { shown: 100, total: 140 } }]);
    expect(hidden.list()).toHaveLength(3);
    hidden.forgetGone([pull(8)], [github, { cli: "glab", host: "gitlab.com", login: "dana", error: "unavailable" }]);
    expect(hidden.list().map((h) => h.key).sort()).toEqual([pull(8).key, "gitlab.com/northwind/data#3:pull"]);
  });

  test("only the newest are kept", () => {
    const hidden = createInboxPullHidden(scratch());
    for (let round = 0; round < 3; round++) {
      hidden.change({ hide: Array.from({ length: 200 }, (_, i) => hide(round * 200 + i)), show: [] }, new Date(Date.UTC(2026, 10, 17, round)));
    }
    expect(hidden.list()).toHaveLength(PULL_HIDDEN_KEPT);
    // The oldest hides go first: half of the first 200, none of the later ones.
    const kept = (from: number) => Array.from({ length: 200 }, (_, i) => hidden.has(pull(from + i).key)).filter(Boolean).length;
    expect([kept(0), kept(200), kept(400)]).toEqual([100, 200, 200]);
  });

  test("a file it cannot read is moved aside, never written over", () => {
    const dataDir = scratch();
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", INBOX_PULL_HIDDEN_FILE), "not json");
    const hidden = createInboxPullHidden(dataDir);
    expect(hidden.list()).toEqual([]);
    hidden.change({ hide: [hide(7)], show: [] }, new Date());
    expect(JSON.parse(readFileSync(join(dataDir, "inbox", INBOX_PULL_HIDDEN_FILE), "utf8")).hidden[KEY].title).toBe("PR 7");
  });

  test("a write names PRs by key, with their title and https link; anything else is refused", () => {
    expect(pullHiddenBodyOf({ hide: [hide(7)], show: [pull(8).key] })).toEqual({ hide: [hide(7)], show: [pull(8).key] });
    for (const body of [{}, { hide: [] }, { hide: [{ ...hide(7), url: "javascript:alert(1)" }] }, { hide: [{ key: KEY }] }, { show: [""] }, { hide: "x" }, { show: Array.from({ length: 201 }, (_, i) => `k${i}`) }]) {
      expect(() => pullHiddenBodyOf(body as Record<string, unknown>)).toThrow();
    }
  });
});

describe("Reviews' rows with hidden PRs", () => {
  const row = (over: Partial<InboxReviewRow>): InboxReviewRow => ({ id: "thr_a", reviewed: true, move: "on_you", reason: "review_ready", thread_id: "thr_a", review: null, stacks: [], pull_keys: [], link: null, pull_reason: null, landed: [], updated_at: "2026-11-17T10:00:00Z", ...over }) as InboxReviewRow;

  test("a review thread left with no PR only because its PRs are hidden leaves; a local review and a thread with a PR shown stay", () => {
    const owned = row({ id: "thr_a", thread_id: "thr_a" });
    const local = row({ id: "thr_b", thread_id: "thr_b", started: { kind: "local" } as InboxReviewRow["started"] });
    const other = row({ id: "thr_c", thread_id: "thr_c" });
    const withPr = row({ id: "thr_d", thread_id: "thr_d", stacks: [{ id: pull(9).key } as InboxReviewRow["stacks"][number]], pull_keys: [pull(9).key] });
    // thr_b started as a review of local changes and was handed a PR since: hiding the PR leaves the local review.
    const owners: Record<string, string> = { [KEY]: "thr_a", [pull(8).key]: "thr_d", [pull(10).key]: "thr_b" };
    const shown = reviewRowsShown([owned, local, other, withPr], [KEY, pull(8).key, pull(10).key], (key) => owners[key] ?? null);
    expect(shown.map((r) => r.id)).toEqual(["thr_b", "thr_c", "thr_d"]);
    expect(reviewRowsShown([owned], [], () => "thr_a").map((r) => r.id)).toEqual(["thr_a"]);
  });
});
