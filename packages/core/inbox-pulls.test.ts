/**
 * Pull requests in the Inbox: stacks and whose move it is. What regresses:
 *  - a stack drawn as separate rows (or two stacks joined), or its layers out of landing order;
 *  - a fork's branch of the same name taken as a layer of someone else's stack;
 *  - a merged layer lost from under its stack, or a merged PR under no stack shown on its own;
 *  - two PRs whose bases point at each other looping forever or vanishing;
 *  - a teammate's review request left out of On you, or the person's agent's PR not on them;
 *  - a draft, or a PR whose checks still run, put on the person; an approved one not ready to land;
 *  - a stack placed by its top layer instead of by the layer that is on the person.
 */
import { describe, expect, test } from "bun:test";
import {
  inboxPullGroups,
  inboxPullItems,
  inboxPullLandsNext,
  inboxPullMove,
  inboxPullStacks,
  inboxPullUrlsIn,
  type InboxPull,
} from "./inbox-pulls";

let n = 0;
function pr(fields: Partial<InboxPull> & { number: number; head: string; base?: string }): InboxPull {
  n++;
  const repo = fields.repo ?? "northwind/billing-svc";
  return {
    key: `github.com/${repo}#${fields.number}`.toLowerCase(),
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
    head_repo: repo,
    additions: 1,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: "success",
    updated_at: `2026-11-0${(n % 8) + 1}T10:00:00.000Z`,
    merged_at: null,
    ...fields,
  };
}

const keys = (pulls: readonly InboxPull[]) => pulls.map((p) => p.number);

describe("inboxPullStacks", () => {
  test("a chain of bases is one stack, bottom to top; a lone PR is its own", () => {
    const top = pr({ number: 414, head: "retry/dunning", base: "retry/backoff", state: "draft" });
    const mid = pr({ number: 413, head: "retry/backoff", base: "retry/schedule" });
    const low = pr({ number: 412, head: "retry/schedule", base: "main" });
    const lone = pr({ number: 500, head: "docs/readme", base: "main" });
    const stacks = inboxPullStacks([top, lone, mid, low]);
    expect(stacks.map((s) => keys(s.layers))).toEqual([[412, 413, 414], [500]]);
    expect(stacks[0]!.base).toBe("main");
    expect(stacks[0]!.id).toBe(top.key);
    expect(inboxPullLandsNext(stacks[0]!)?.number).toBe(412);
  });

  test("a merged layer still under the lowest open one goes beneath it; one under no stack is left out", () => {
    const merged = pr({ number: 411, head: "retry/charge-client", base: "main", state: "merged", merged_at: "2026-11-02T10:00:00.000Z" });
    const stray = pr({ number: 300, head: "old/thing", base: "main", state: "merged" });
    const low = pr({ number: 412, head: "retry/schedule", base: "retry/charge-client" });
    const [stack, ...rest] = inboxPullStacks([low, merged, stray]);
    expect(keys(stack!.layers)).toEqual([411, 412]);
    expect(stack!.base).toBe("main");
    expect(rest).toEqual([]);
    expect(inboxPullLandsNext(stack!)?.number).toBe(412);
  });

  test("the same branch name in another repository, or from a fork, is not a layer", () => {
    const low = pr({ number: 1, head: "feature/a", base: "main" });
    const otherRepo = pr({ number: 2, head: "feature/b", base: "feature/a", repo: "northwind/web-app" });
    const forkLow = pr({ number: 3, head: "feature/c", base: "main", head_repo: "someone/billing-svc" });
    const onFork = pr({ number: 4, head: "feature/d", base: "feature/c" });
    const stacks = inboxPullStacks([low, otherRepo, forkLow, onFork]);
    expect(stacks.map((s) => keys(s.layers))).toEqual([[1], [2], [3], [4]]);
  });

  test("two PRs based on each other make one stack, the lower number first", () => {
    const a = pr({ number: 7, head: "x", base: "y" });
    const b = pr({ number: 8, head: "y", base: "x" });
    expect(inboxPullStacks([b, a]).map((s) => keys(s.layers))).toEqual([[7, 8]]);
  });

  test("two layers on one branch stay in one stack, by depth then number", () => {
    const low = pr({ number: 10, head: "base-work", base: "main" });
    const b = pr({ number: 12, head: "b", base: "base-work" });
    const a = pr({ number: 11, head: "a", base: "base-work" });
    expect(inboxPullStacks([b, a, low]).map((s) => keys(s.layers))).toEqual([[10, 11, 12]]);
  });
});

describe("whose move", () => {
  test("each PR's move and why", () => {
    expect(inboxPullMove(pr({ number: 1, head: "a", mine: false, requested: true, author: "tomas" }), false)).toEqual({ move: "on_you", reason: "requested" });
    expect(inboxPullMove(pr({ number: 2, head: "b" }), true)).toEqual({ move: "on_you", reason: "agent_ready" });
    expect(inboxPullMove(pr({ number: 3, head: "c", checks: "pending" }), true)).toEqual({ move: "waiting", reason: "running" });
    expect(inboxPullMove(pr({ number: 4, head: "d", state: "draft" }), true)).toEqual({ move: "waiting", reason: "draft" });
    expect(inboxPullMove(pr({ number: 5, head: "e", review: "approved", approved_by: "priya" }), false)).toEqual({ move: "ready", reason: "approved" });
    expect(inboxPullMove(pr({ number: 6, head: "f", review: "approved", checks: "pending" }), false)).toEqual({ move: "waiting", reason: "approved_running" });
    expect(inboxPullMove(pr({ number: 7, head: "g", review: "changes_requested" }), false)).toEqual({ move: "on_you", reason: "changes" });
    expect(inboxPullMove(pr({ number: 8, head: "h", checks: "failure" }), false)).toEqual({ move: "on_you", reason: "failing" });
    expect(inboxPullMove(pr({ number: 9, head: "i", reviewers: ["jun"] }), false)).toEqual({ move: "waiting", reason: "review" });
    expect(inboxPullMove(pr({ number: 10, head: "j", mine: false, author: "mara" }), false)).toEqual({ move: "waiting", reason: "others" });
  });

  test("the groups: On you holds teammates' requests and the agents' PRs; a stack goes by the layer on the person", () => {
    const linked = new Set<string>();
    const stackLow = pr({ number: 412, head: "retry/schedule", base: "main", updated_at: "2026-11-03T08:00:00.000Z" });
    const stackMid = pr({ number: 413, head: "retry/backoff", base: "retry/schedule", updated_at: "2026-11-03T09:00:00.000Z" });
    const stackTop = pr({ number: 414, head: "retry/dunning", base: "retry/backoff", state: "draft", checks: "pending", updated_at: "2026-11-03T07:00:00.000Z" });
    linked.add(stackTop.key);
    const teammate = pr({ number: 880, head: "rtl", repo: "northwind/web-app", mine: false, requested: true, author: "tomas", updated_at: "2026-11-03T10:00:00.000Z" });
    const ready = pr({ number: 872, head: "vite", repo: "northwind/web-app", review: "approved", approved_by: "priya", updated_at: "2026-11-03T11:00:00.000Z" });
    const waiting = pr({ number: 869, head: "locale", repo: "northwind/web-app", reviewers: ["jun"] });
    const running = pr({ number: 61, head: "csv", repo: "northwind/ledger", checks: "pending" });
    linked.add(running.key);
    const items = inboxPullItems(inboxPullStacks([stackTop, teammate, stackMid, ready, waiting, stackLow, running]), (p) => linked.has(p.key));
    const groups = inboxPullGroups(items);
    expect(groups.on_you.map((i) => keys(i.stack.layers))).toEqual([[880], [412, 413, 414]]);
    // The stack's link (on its draft top) makes every open layer the agent's: the row speaks of the lowest one on the person.
    const stack = groups.on_you[1]!;
    expect(stack.focus.number).toBe(412);
    expect(stack.reason).toBe("agent_ready");
    expect(stack.updated_at).toBe("2026-11-03T09:00:00.000Z");
    expect(groups.ready.map((i) => i.focus.number)).toEqual([872]);
    expect(groups.waiting.map((i) => i.focus.number).sort()).toEqual([61, 869]);
  });

  test("a stack whose next layer is approved and nothing is on the person is ready to land", () => {
    const low = pr({ number: 20, head: "a", review: "approved", approved_by: "priya" });
    const top = pr({ number: 21, head: "b", base: "a", state: "draft" });
    const [item] = inboxPullItems(inboxPullStacks([low, top]), () => false);
    expect(item!.move).toBe("ready");
    expect(item!.focus.number).toBe(20);
  });
});

test("inboxPullUrlsIn finds pull and merge request links, each once", () => {
  const text = "Ready: https://github.com/northwind/billing-svc/pull/412 and https://gitlab.com/northwind/ledger/-/merge_requests/57. Again https://github.com/northwind/billing-svc/pull/412 — not https://github.com/northwind/billing-svc/issues/3";
  expect(inboxPullUrlsIn(text)).toEqual(["https://github.com/northwind/billing-svc/pull/412", "https://gitlab.com/northwind/ledger/-/merge_requests/57"]);
});
