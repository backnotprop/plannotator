/**
 * Hidden pull requests on the machine whose window hid them (inbox-pull-hidden.ts). What regresses: a hide lost across
 * a restart or readable by others, a PR that merged or closed kept hidden forever, an open one forgotten (a read that
 * does not list it is no sign it closed), a hidden PR still listed, a write that is no PR (a link that is not a web
 * link), the records growing without end, a review thread's row left in Reviews with no PR because its PRs are hidden
 * (or a local review taken away with it), and the Inbox list keeping a thread whose PRs are all hidden (or dropping
 * one with a PR still shown).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxPull, InboxReviewRow } from "@plannotator/core/inbox-types";
import { createInboxPullHidden, INBOX_PULL_HIDDEN_FILE, PULL_HIDDEN_KEPT, pullHiddenBodyOf, reviewRowsShown, threadPullsHidden, threadStaysHidden, type PullToHide } from "./inbox-pull-hidden";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-pull-hidden-"));
  dirs.push(dir);
  return dir;
};

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

  test("a fork's PR keeps its head repository across a restart (the Hidden fold's project rule); one without has none", () => {
    const dataDir = scratch();
    createInboxPullHidden(dataDir).change({ hide: [{ ...hide(8), head_repo: "dana/api" }, { ...hide(9), head_repo: null }], show: [] }, new Date("2026-11-17T10:00:00Z"));
    const kept = createInboxPullHidden(dataDir).list();
    expect(kept.find((h) => h.key.endsWith("#8"))?.head_repo).toBe("dana/api");
    expect(kept.find((h) => h.key.endsWith("#9"))).not.toHaveProperty("head_repo");
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

  test("a read that does not list it forgets nothing: only a read that sees it merged or closed does", () => {
    const hidden = createInboxPullHidden(scratch());
    hidden.change({ hide: [hide(7), hide(8)], show: [] }, new Date());
    expect(hidden.settle([])).toBe(false);
    expect(hidden.settle([pull(9, { state: "closed" })])).toBe(false);
    expect(hidden.list()).toHaveLength(2);
    expect(hidden.settle([pull(8, { state: "closed" })])).toBe(true);
    expect(hidden.list().map((h) => h.key)).toEqual([pull(7).key]);
  });

  test("the thread a hidden PR belongs to is kept with it", () => {
    const dataDir = scratch();
    createInboxPullHidden(dataDir).change({ hide: [{ ...hide(7), thread_id: "thr_a" }, { ...hide(8), thread_id: null }], show: [] }, new Date("2026-11-17T10:00:00Z"));
    const list = createInboxPullHidden(dataDir).list();
    expect(list.find((h) => h.key === pull(7).key)!.thread_id).toBe("thr_a");
    expect(list.find((h) => h.key === pull(8).key)!.thread_id).toBeUndefined();
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

  test("a write names PRs by key, with their title and web link, or threads by id; anything else is refused", () => {
    expect(pullHiddenBodyOf({ hide: [hide(7)], show: [pull(8).key] })).toMatchObject({ hide: [hide(7)], threads: [], show: [pull(8).key] });
    expect(pullHiddenBodyOf({ threads: ["thr_a"] })).toMatchObject({ hide: [], threads: ["thr_a"], show: [] });
    // A self-hosted forge on plain http, as a linked machine's list may carry.
    const plain = { key: "git.lan/team/app#4:pull", title: "MR 4", url: "http://git.lan/team/app/-/merge_requests/4" };
    expect(pullHiddenBodyOf({ hide: [plain] }).hide).toEqual([plain]);
    for (const body of [{}, { hide: [] }, { hide: [{ ...hide(7), url: "javascript:alert(1)" }] }, { hide: [{ key: KEY }] }, { show: [""] }, { threads: [3] }, { hide: "x" }, { show: Array.from({ length: 201 }, (_, i) => `k${i}`) }]) {
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

describe("the Inbox list's threads with hidden PRs", () => {
  const inPlay = (threads: Record<string, number[]>) =>
    new Map(Object.entries(threads).map(([id, numbers]) => [id, new Map<string, PullToHide>(numbers.map((n) => [pull(n).key, { ...hide(n), thread_id: id }]))]));
  const T1 = "2026-11-17T10:00:00.000Z";
  const T2 = "2026-11-17T11:00:00.000Z";

  test("a thread whose PRs in play are all hidden leaves, with its newest hide; one with a PR still shown stays and offers that one", () => {
    const at: Record<string, string> = { [pull(7).key]: T1, [pull(8).key]: T1, [pull(11).key]: T2 };
    const { gone, hideable } = threadPullsHidden(inPlay({ thr_a: [7], thr_b: [8, 9], thr_c: [10], thr_d: [], thr_e: [7, 11] }), (key) => at[key] ?? null);
    expect([...gone]).toEqual([["thr_a", T1], ["thr_e", T2]]);
    expect(hideable.get("thr_b")!.map((p) => p.key)).toEqual([pull(9).key]);
    expect(hideable.get("thr_c")!.map((p) => p.key)).toEqual([pull(10).key]);
    // A thread with no PR in play is neither.
    expect(hideable.has("thr_d")).toBe(false);
    expect(threadPullsHidden(inPlay({ thr_a: [7] }), () => null).gone.size).toBe(0);
  });

  test("it stays out until something newer than the hide happens in it; never while pinned or snoozed", () => {
    const quiet = { pinned: false, snoozed: false, activity: ["2026-11-17T09:00:00.000Z", null] };
    expect(threadStaysHidden(T1, quiet)).toBe(true);
    // An agent message (or a question, a prompt, a stop, the person's own send, a snooze come due) after the hide.
    expect(threadStaysHidden(T1, { ...quiet, activity: ["2026-11-17T09:00:00.000Z", "2026-11-17T10:00:01.000Z"] })).toBe(false);
    // A newer hide takes it out again.
    expect(threadStaysHidden(T2, { ...quiet, activity: ["2026-11-17T10:00:01.000Z"] })).toBe(true);
    // The same millisecond as the hide counts as newer: it shows.
    expect(threadStaysHidden(T1, { ...quiet, activity: [T1] })).toBe(false);
    expect(threadStaysHidden(T1, { ...quiet, pinned: true })).toBe(false);
    expect(threadStaysHidden(T1, { ...quiet, snoozed: true })).toBe(false);
  });

  test("a thread that came back stays back across a restart, until a newer return replaces it", () => {
    const dataDir = scratch();
    const hidden = createInboxPullHidden(dataDir);
    hidden.change({ hide: [hide(7)], show: [] }, new Date(T1));
    hidden.markBack([{ thread_id: "thr_a", at: T2 }]);
    hidden.markBack([{ thread_id: "thr_a", at: T1 }]);
    const again = createInboxPullHidden(dataDir);
    expect(again.backOf("thr_a")).toBe(T2);
    expect(again.atOf(pull(7).key)).toBe(T1);
    expect(again.atOf(pull(8).key)).toBeNull();
  });

  test("a thread hidden again is kept across a restart, and Undo takes that off", () => {
    const dataDir = scratch();
    const hidden = createInboxPullHidden(dataDir);
    hidden.rehide({ hide: ["thr_a", "thr_b"], show: [] }, new Date(T2));
    expect(createInboxPullHidden(dataDir).rehidOf("thr_a")).toBe(T2);
    createInboxPullHidden(dataDir).rehide({ hide: [], show: ["thr_a"] }, new Date());
    const after = createInboxPullHidden(dataDir);
    expect(after.rehidOf("thr_a")).toBeNull();
    expect(after.rehidOf("thr_b")).toBe(T2);
  });
});

describe("the repositories a machine keeps hidden", () => {
  const REPO = "github.com/northwind/api";
  const other = (number: number) => pull(number, { key: `github.com/northwind/web#${number}`, repo: "northwind/web" });

  test("every PR in a hidden repository is hidden, a new one too, across a restart; Show again brings them all back", () => {
    const dataDir = scratch();
    const hidden = createInboxPullHidden(dataDir);
    hidden.change({ hide: [], show: [], hide_repos: [{ key: REPO, label: "api" }] }, new Date("2026-11-17T10:00:00Z"));
    const again = createInboxPullHidden(dataDir);
    // #900 was never seen before the hide: new PRs there stay hidden too.
    expect(again.shown([pull(7), pull(900), other(8)]).map((p) => p.key)).toEqual([other(8).key]);
    expect(again.has(pull(900).key)).toBe(true);
    expect(again.repos()).toEqual([{ key: REPO, label: "api", at: "2026-11-17T10:00:00.000Z" }]);
    // The hidden PRs' list stays the PRs hidden one by one.
    expect(again.list()).toEqual([]);
    again.change({ hide: [], show: [], show_repos: [REPO] }, new Date());
    expect(createInboxPullHidden(dataDir).shown([pull(7), other(8)])).toHaveLength(2);
  });

  test("a hidden repository never takes a thread out of the Inbox list: only PRs hidden one by one do", () => {
    const hidden = createInboxPullHidden(scratch());
    hidden.change({ hide: [], show: [], hide_repos: [{ key: REPO, label: "api" }] }, new Date("2026-11-17T10:00:00Z"));
    expect(hidden.atOf(pull(7).key)).toBeNull();
    const inPlay = new Map([["thr_a", new Map([[pull(7).key, { ...hide(7), thread_id: "thr_a" }]])]]);
    expect(threadPullsHidden(inPlay, (key) => hidden.atOf(key)).gone.size).toBe(0);
    hidden.change({ hide: [hide(7)], show: [] }, new Date("2026-11-17T11:00:00Z"));
    expect([...threadPullsHidden(inPlay, (key) => hidden.atOf(key)).gone.keys()]).toEqual(["thr_a"]);
  });

  test("the newest 500 hidden repositories are kept", () => {
    const hidden = createInboxPullHidden(scratch());
    const many = Array.from({ length: PULL_HIDDEN_KEPT + 1 }, (_, i) => ({ key: `github.com/o/r${i}`, label: `r${i}` }));
    for (const [i, repo] of many.entries()) hidden.change({ hide: [], show: [], hide_repos: [repo] }, new Date(Date.parse("2026-11-17T10:00:00Z") + i * 1000));
    expect(hidden.repos()).toHaveLength(PULL_HIDDEN_KEPT);
    expect(hidden.has("github.com/o/r0#1")).toBe(false);
    expect(hidden.has(`github.com/o/r${PULL_HIDDEN_KEPT}#1`)).toBe(true);
  });

  test("a write's repositories: host/owner/repo, lowercased; a PR's key is refused", () => {
    expect(pullHiddenBodyOf({ hide_repos: [{ key: "GitHub.com/Northwind/API", label: "API" }] }).hide_repos).toEqual([{ key: REPO, label: "API" }]);
    expect(pullHiddenBodyOf({ show_repos: [REPO] }).show_repos).toEqual([REPO]);
    expect(() => pullHiddenBodyOf({ hide_repos: [{ key: `${REPO}#7`, label: "api" }] })).toThrow();
    expect(() => pullHiddenBodyOf({ hide_repos: "api" })).toThrow();
  });
});
