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
  inboxPullAncestors,
  inboxPullGroups,
  inboxPullItems,
  inboxPullLandsNext,
  inboxPullParent,
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

  test("a merged long-lived branch, or one other open PRs are based on, is never a stack's bottom", () => {
    const release = pr({ number: 50, head: "develop", base: "main", state: "merged" });
    const onDevelop = pr({ number: 51, head: "feat/a", base: "develop" });
    const [stack] = inboxPullStacks([onDevelop, release]);
    expect(keys(stack!.layers)).toEqual([51]);
    expect(stack!.base).toBe("develop");

    // A merged branch two separate open PRs are based on is shared ground, not a layer of either.
    const shared = pr({ number: 60, head: "platform-v2", base: "main", state: "merged" });
    const a = pr({ number: 61, head: "a", base: "platform-v2" });
    const b = pr({ number: 62, head: "b", base: "platform-v2" });
    const stacks = inboxPullStacks([a, b, shared]);
    expect(stacks.map((s) => keys(s.layers))).toEqual([[61], [62]]);
  });

  test("the whole stack runs from the lowest open layer's base, under the merged layers", () => {
    const merged = pr({ number: 411, head: "retry/charge-client", base: "main", state: "merged" });
    const low = pr({ number: 412, head: "retry/schedule", base: "retry/charge-client" });
    const [stack] = inboxPullStacks([low, merged]);
    expect(stack!.base).toBe("main");
    expect(stack!.open_base).toBe("retry/charge-client");
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

  test("a merged layer in the middle (merged into an open PR's branch): the stack runs from that open PR up, the merged one between", () => {
    const fx = pr({ number: 48150, head: "fx-cache", base: "main" });
    const ttl = pr({ number: 48151, head: "fx-cache-ttl", base: "fx-cache", state: "merged" });
    const metrics = pr({ number: 48152, head: "fx-cache-metrics", base: "fx-cache-ttl" });
    const alerts = pr({ number: 48153, head: "fx-cache-alerts", base: "fx-cache-metrics" });
    const stacks = inboxPullStacks([alerts, metrics, ttl, fx]);
    expect(stacks.map((s) => keys(s.layers))).toEqual([[48150, 48151, 48152, 48153]]);
    // What lands next is the open PR at the bottom, not the layer above the merged one.
    expect(inboxPullLandsNext(stacks[0]!)?.number).toBe(48150);
    expect(stacks[0]!.base).toBe("main");
    expect(stacks[0]!.open_base).toBe("main");
  });

  test("two open PRs from one branch (a backport): the layer based on that branch sits on the one into the trunk, whatever the numbers and order", () => {
    // The backport has the lower number: the rank is the trunk, not the number.
    const backport = pr({ number: 320, head: "fix-rounding", base: "release/2026.10" });
    const main = pr({ number: 321, head: "fix-rounding", base: "main" });
    const tests = pr({ number: 322, head: "fix-rounding-tests", base: "fix-rounding" });
    for (const order of [
      [backport, main, tests],
      [tests, main, backport],
      [main, backport, tests],
    ]) {
      const stacks = inboxPullStacks(order);
      expect(stacks.map((s) => keys(s.layers)).sort()).toEqual([[320], [321, 322]]);
    }
    // The forge's default branch is the trunk, whatever its name: into `next` beats into `release/…`.
    const intoRelease = pr({ number: 39, head: "shared-next", base: "release/1", default_branch: "next" });
    const intoNext = pr({ number: 40, head: "shared-next", base: "next", default_branch: "next" });
    const onShared = pr({ number: 41, head: "on-shared", base: "shared-next", default_branch: "next" });
    expect(inboxPullStacks([intoRelease, intoNext, onShared]).find((s) => s.layers.some((l) => l.number === 41))!.layers.map((l) => l.number)).toEqual([40, 41]);
    // Into a feature branch and into main: main's PR takes the layers above it.
    const feature = pr({ number: 30, head: "shared", base: "feature/epic" });
    const intoMain = pr({ number: 31, head: "shared", base: "main" });
    const above = pr({ number: 32, head: "above", base: "shared" });
    expect(inboxPullStacks([feature, intoMain, above]).find((s) => s.layers.some((l) => l.number === 32))!.layers.map((l) => l.number)).toEqual([31, 32]);
  });

  test("two layers on one branch stay in one stack, by depth then number", () => {
    const low = pr({ number: 10, head: "base-work", base: "main" });
    const b = pr({ number: 12, head: "b", base: "base-work" });
    const a = pr({ number: 11, head: "a", base: "base-work" });
    expect(inboxPullStacks([b, a, low]).map((s) => keys(s.layers))).toEqual([[10, 11, 12]]);
  });

  test("each layer's parent is the layer it sits on, never its neighbour in the list (a fork, merged layers under and between)", () => {
    // A on main; B and C on A (a fork); D on B. In the list D comes after C, but D sits on B.
    const a = pr({ number: 1, head: "a", base: "main" });
    const b = pr({ number: 2, head: "b", base: "a" });
    const c = pr({ number: 3, head: "c", base: "a" });
    const d = pr({ number: 4, head: "d", base: "b" });
    const [fork] = inboxPullStacks([d, c, b, a]);
    expect(keys(fork!.layers)).toEqual([1, 2, 3, 4]);
    const parentNumber = (pull: InboxPull) => inboxPullParent(fork!, pull.key)?.number ?? null;
    expect([a, b, c, d].map(parentNumber)).toEqual([null, 1, 1, 2]);
    expect(keys(inboxPullAncestors(fork!, d.key))).toEqual([2, 1]);
    expect(keys(inboxPullAncestors(fork!, c.key))).toEqual([1]);
    // Merged under the root, and merged in the middle: each sits on the one below it.
    const old = pr({ number: 50, head: "fx-base", base: "main", state: "merged" });
    const fx = pr({ number: 51, head: "fx-cache", base: "fx-base" });
    const ttl = pr({ number: 52, head: "fx-cache-ttl", base: "fx-cache", state: "merged" });
    const metrics = pr({ number: 53, head: "fx-cache-metrics", base: "fx-cache-ttl" });
    const [chain] = inboxPullStacks([metrics, ttl, fx, old]);
    expect(keys(chain!.layers)).toEqual([50, 51, 52, 53]);
    expect(chain!.layers.map((l) => inboxPullParent(chain!, l.key)?.number ?? null)).toEqual([null, 50, 51, 52]);
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

  test("an approved PR that conflicts with its base is not ready to land: it is on the person", () => {
    expect(inboxPullMove(pr({ number: 82, head: "kms", review: "approved", approved_by: "jo", conflicts: true }), false)).toEqual({ move: "on_you", reason: "conflicts" });
    expect(inboxPullMove(pr({ number: 83, head: "kms2", review: "approved", approved_by: "jo", conflicts: false }), false)).toEqual({ move: "ready", reason: "approved" });
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
