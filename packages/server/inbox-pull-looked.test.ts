/**
 * "Changed since you looked" on the machine that lists the PR (inbox-pull-looked.ts), and on the merged board
 * (inbox-machine-pulls.ts). What regresses: an older look held in an outbox landing over a newer one, a look from
 * the future, a look that is no whole commit id kept or carried from another machine, the file readable by others,
 * the kept looks growing without end, the list not carrying a PR's look, a linked machine's look lost on the merged
 * board, and a machine too old to keep looks told it does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxPull, InboxPullsAnswer } from "@plannotator/core/inbox-types";
import { createMachinePulls, mergePullBoards, parseFarBoard } from "./inbox-machine-pulls";
import type { PeerLink } from "./inbox-peer-link";
import { createInboxPullLooked, INBOX_PULL_LOOKED_FILE, PULL_LOOKED_KEPT, pullLookedSeenOf } from "./inbox-pull-looked";

const B = "ibx_01K0000000000000000000000B";
const C = "ibx_01K0000000000000000000000C";
const SHA = (c: string) => c.repeat(40);
const KEY = "github.com/northwind/api#7";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-pull-looked-"));
  dirs.push(dir);
  return dir;
};

const pull = (repo: string, number: number, over: Partial<InboxPull> = {}): InboxPull =>
  ({ key: `github.com/${repo}#${number}`, platform: "github", host: "github.com", repo, number, url: `https://github.com/${repo}/pull/${number}`, title: `PR ${number}`, author: "dana", mine: true, requested: false, state: "open", base: "main", head: `b${number}`, head_repo: repo, additions: 1, deletions: 1, files: 1, review: null, approved_by: null, reviewers: [], checks: null, updated_at: "2026-11-14T10:00:00Z", merged_at: null, ...over }) as InboxPull;

describe("the looks a machine keeps", () => {
  test("the newer look wins, so an older one held while the machine slept never lands over it; kept 0600 across a restart", () => {
    const dataDir = scratch();
    const looked = createInboxPullLooked(dataDir);
    expect(looked.mark([{ key: KEY, sha: SHA("b"), at: 2_000 }])).toEqual({ [KEY]: { sha: SHA("b"), at: 2_000 } });
    expect(looked.mark([{ key: KEY, sha: SHA("a"), at: 1_000 }])).toEqual({ [KEY]: { sha: SHA("b"), at: 2_000 } });
    const file = join(dataDir, "inbox", INBOX_PULL_LOOKED_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, looked: { [KEY]: { sha: SHA("b"), at: 2_000 } } });
    expect(createInboxPullLooked(dataDir).all().get(KEY)).toEqual({ sha: SHA("b"), at: 2_000 });
  });

  test("the list carries each PR's look; a PR never looked at carries none", () => {
    const looked = createInboxPullLooked(scratch());
    looked.mark([{ key: KEY, sha: SHA("b"), at: 1 }]);
    const [seen, never] = looked.on([pull("northwind/api", 7), pull("northwind/api", 8)]);
    expect(seen!.looked).toEqual({ sha: SHA("b"), at: 1 });
    expect("looked" in never!).toBe(false);
  });

  test("the newest looks are kept, the oldest go", () => {
    const looked = createInboxPullLooked(scratch());
    looked.mark(Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, sha: SHA("a"), at: i + 1 })));
    for (let round = 1; round < 5; round++) looked.mark(Array.from({ length: 100 }, (_, i) => ({ key: `k${round * 100 + i}`, sha: SHA("a"), at: round * 100 + i + 1 })));
    expect(looked.all().size).toBe(PULL_LOOKED_KEPT);
    expect(looked.all().has("k0")).toBe(false);
    expect(looked.all().has("k499")).toBe(true);
  });

  test("a write names whole commit ids and keys; a time ahead of now is now", () => {
    expect(pullLookedSeenOf({ seen: [{ key: KEY, sha: SHA("B"), at: 9_000 }] }, 5_000)).toEqual([{ key: KEY, sha: SHA("b"), at: 5_000 }]);
    for (const seen of [[{ key: KEY, sha: "main", at: 1 }], [{ key: KEY, sha: "abc123", at: 1 }], [{ key: "", sha: SHA("a"), at: 1 }], [{ key: KEY, sha: SHA("a") }], [], "x"]) {
      expect(() => pullLookedSeenOf({ seen }, 5_000)).toThrow();
    }
  });
});

describe("a linked machine's looks on the merged board", () => {
  test("its PR keeps the look it carries; one that is no whole commit id is dropped", () => {
    const board = parseFarBoard({ pulls: [pull("northwind/api", 7, { looked: { sha: SHA("b"), at: 5 } }), pull("northwind/api", 8, { looked: { sha: "main", at: 5 } as never })] }, null, "t")!;
    expect(board.pulls[0]!.looked).toEqual({ sha: SHA("b"), at: 5 });
    expect("looked" in board.pulls[1]!).toBe(false);
    const local: Pick<InboxPullsAnswer, "pulls" | "links" | "projects" | "cards" | "hosts"> = { pulls: [], links: {}, projects: {}, cards: {}, hosts: [] };
    const merged = mergePullBoards(local, [{ machine: B, board, pending: false, looked: true }]);
    expect(merged.pulls[0]).toMatchObject({ key: KEY, machine: B, looked: { sha: SHA("b"), at: 5 } });
    expect(merged.machines[B]).toEqual({ read_at: "t", pending: false, looked: true });
  });

  test("only a machine that says it keeps looks (mark `pulls-looked`) is named as keeping them", async () => {
    const peer = (id: string, marks: string[]) =>
      ({ id, state: "online", list: { marks }, request: async (route: string) => Response.json(route === "pulls" ? { pulls: [] } : { judgments: {} }) }) as unknown as PeerLink;
    const pulls = createMachinePulls({ peers: () => [peer(B, ["pulls", "pulls-looked"]), peer(C, ["pulls"])] });
    const snapshot = pulls.start(false);
    await pulls.settled();
    const merged = mergePullBoards({ pulls: [], links: {}, projects: {}, cards: {}, hosts: [] }, snapshot());
    expect(merged.machines[B]!.looked).toBe(true);
    expect(merged.machines[C]!.looked).toBeUndefined();
  });
});
