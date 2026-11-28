import { describe, expect, test } from "bun:test";
import type { ForgeRef } from "@plannotator/core/forge-ref-card";
import { createRefCards, type RefCli, type RefCommandResult } from "@plannotator/shared/ref-cards";
import { createInboxPullLookups, LOOKUPS_PER_SEND, refCardsKindReader } from "./inbox-pull-lookups";

const ref = (number: number): ForgeRef => ({ platform: "github", host: "github.com", owner: "acme", repo: "api", number, kind: "pull" });

/** A stand-in forge: each number's kind, how many reads ran, and the most that ran at once. */
function forge(kinds: Record<number, "pull" | "issue" | "missing" | null | "throw">, usable = () => true) {
  const reads: number[] = [];
  let running = 0;
  let most = 0;
  const lookups = createInboxPullLookups({
    usable: async () => usable(),
    read: async (r) => {
      reads.push(r.number);
      running++;
      most = Math.max(most, running);
      await Bun.sleep(2);
      running--;
      const kind = kinds[r.number];
      if (kind === "throw") throw new Error("offline");
      return kind ?? "missing";
    },
  });
  return { lookups, reads, most: () => most };
}

describe("the attach line's lookups", () => {
  test("a PR is heard, an issue and a missing number are kept but never heard, and no answer is asked twice", async () => {
    const f = forge({ 1: "pull", 2: "issue", 3: "missing" });
    const heard: number[] = [];
    f.lookups.lookUp([ref(1), ref(2), ref(3)], (r) => heard.push(r.number));
    await f.lookups.idle();
    expect(heard).toEqual([1]);
    expect([1, 2, 3].map((n) => f.lookups.answer(`github.com/acme/api#${n}`)?.kind)).toEqual(["pull", "issue", "missing"]);
    f.lookups.lookUp([ref(1), ref(2), ref(3)], (r) => heard.push(r.number));
    await f.lookups.idle();
    expect(f.reads).toEqual([1, 2, 3]);
    expect(heard).toEqual([1]);
  });

  test("at most three numbers per message, one read at a time, and a bounded wait", async () => {
    const f = forge({});
    const many = Array.from({ length: 40 }, (_, i) => ref(i + 1));
    f.lookups.lookUp(many, () => {});
    expect(f.lookups.sizes().running + f.lookups.sizes().waiting).toBe(LOOKUPS_PER_SEND);
    await f.lookups.idle();
    expect(f.reads).toEqual([1, 2, 3]);
    // Twenty messages at once: never more than one read running, never more than thirty waiting.
    for (let i = 0; i < 20; i++) f.lookups.lookUp([ref(100 + i * 3), ref(101 + i * 3), ref(102 + i * 3)], () => {});
    expect(f.lookups.sizes().waiting).toBeLessThanOrEqual(30);
    await f.lookups.idle();
    expect(f.most()).toBe(1);
  });

  test("a failing forge, or one this Inbox may not use (Code review off, signed out), keeps nothing and says nothing", async () => {
    const failing = forge({ 1: "throw", 2: null });
    const heard: number[] = [];
    failing.lookups.lookUp([ref(1), ref(2)], (r) => heard.push(r.number));
    await failing.lookups.idle();
    expect(heard).toEqual([]);
    expect(failing.lookups.answer("github.com/acme/api#1")).toBeNull();
    // No answer was kept, so a later message asks again.
    failing.lookups.lookUp([ref(1)], () => {});
    await failing.lookups.idle();
    expect(failing.reads).toEqual([1, 2, 1]);

    let on = false;
    const off = forge({ 1: "pull" }, () => on);
    off.lookups.lookUp([ref(1)], (r) => heard.push(r.number));
    await off.lookups.idle();
    expect(off.reads).toEqual([]);
    on = true;
    off.lookups.lookUp([ref(1)], (r) => heard.push(r.number));
    await off.lookups.idle();
    expect(heard).toEqual([1]);
  });

  test("two sends naming one number while it is read both hear it, from one read", async () => {
    const f = forge({ 7: "pull" });
    const heard: string[] = [];
    f.lookups.lookUp([ref(7)], () => heard.push("a"));
    f.lookups.lookUp([ref(7)], () => heard.push("b"));
    await f.lookups.idle();
    expect(heard).toEqual(["a", "b"]);
    expect(f.reads).toEqual([7]);
  });
});

describe("through the hover cards' read with a stand-in gh", () => {
  const answer = (stdout: unknown): RefCommandResult => ({ stdout: JSON.stringify(stdout), stderr: "", exitCode: 0 });
  const item = (typename: "PullRequest" | "Issue") => ({
    data: { repository: { nameWithOwner: "acme/api", issueOrPullRequest: { __typename: typename, number: 1, title: "t", url: "u", state: "OPEN", body: "", author: null, labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0, nodes: [] } } } },
  });

  test("a PR, an issue, no such number; offline and signed out are no answer", async () => {
    const replies: Record<number, RefCommandResult> = {
      1: answer(item("PullRequest")),
      2: answer(item("Issue")),
      3: answer({ data: { repository: { nameWithOwner: "acme/api", issueOrPullRequest: null } } }),
      4: { stdout: "", stderr: "error connecting to api.github.com", exitCode: 1 },
      5: { stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login", exitCode: 4 },
    };
    const cards = createRefCards({
      run: async (_cli: RefCli, args: string[]) => replies[Number(args.find((a) => a.startsWith("number="))?.slice(7))] ?? answer({}),
      avatar: async () => null,
    });
    const read = refCardsKindReader(cards);
    expect(await Promise.all([1, 2, 3, 4, 5].map((n) => read(ref(n))))).toEqual(["pull", "issue", "missing", null, null]);
  });
});
