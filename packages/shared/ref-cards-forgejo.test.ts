/**
 * Forgejo / Gitea reads in the hover cards' lookup: what a reader's failure says on the card, and that a read keeps
 * a CLI's time limit (a stuck instance must not hold a shared slot). No network: the reader is a stand-in, and the
 * runner throws, because a Forgejo card never runs `gh` or `glab`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { learnForgejoHosts } from "@plannotator/core/forge-refs";
import type { ForgeRefCardData } from "@plannotator/core/forge-ref-card";
import { fetchFjCard } from "./pr-forgejo";
import { createRefCards, type ForgejoRefReader, type RefRunner } from "./ref-cards";

const URL_OF = (n: number) => `https://codeberg.org/acme/billing/pulls/${n}`;
const LIMIT_MS = 150;
const noCli: RefRunner = async () => {
  throw new Error("a Forgejo card must never run a CLI");
};

afterEach(() => learnForgejoHosts([]));

const card = (ref: { host: string; owner: string; repo: string; number: number }, extra: Partial<ForgeRefCardData> = {}): ForgeRefCardData => ({
  platform: "forgejo", kind: "pull", repo: `${ref.owner}/${ref.repo}`, number: ref.number, url: URL_OF(ref.number), title: "Retry invoices", state: "open",
  author: { login: "ada", avatarUrl: null }, createdAt: "", updatedAt: "", closedAt: null, labels: [], assignees: [], comments: 0, body: "", bodyCut: false, lastComment: null, linked: [],
  pull: { base: "main", head: "retries", additions: 0, deletions: 0, files: 0, review: null, checks: null }, ...extra,
});

const failing = (status: number): ForgejoRefReader => async () => {
  throw Object.assign(new Error(`HTTP ${status}`), { status });
};

describe("Forgejo card reads", () => {
  test("a read that answers is a card, once: the second look is the cache's", async () => {
    let reads = 0;
    const cards = createRefCards({ run: noCli, avatar: async () => null, forgejo: async (ref) => (reads++, card(ref)) });
    expect(await cards.get(URL_OF(7))).toMatchObject({ ok: true, data: { title: "Retry invoices", number: 7 } });
    expect(await cards.get(URL_OF(7))).toMatchObject({ ok: true });
    expect(reads).toBe(1);
  });

  test.each([
    [401, "signed_out"],
    [403, "not_found"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [0, "unavailable"],
  ])("HTTP %d reads as %s on the card", async (status, error) => {
    const cards = createRefCards({ run: noCli, avatar: async () => null, forgejo: failing(status) });
    expect(await cards.get(URL_OF(1))).toMatchObject({ ok: false, error });
  });

  test("a rate limit holds the host: the next card is not asked", async () => {
    let reads = 0;
    const cards = createRefCards({ run: noCli, avatar: async () => null, forgejo: async (ref) => { reads++; if (ref.number === 1) throw Object.assign(new Error("slow down"), { status: 429 }); return card(ref); } });
    expect(await cards.get(URL_OF(1))).toMatchObject({ error: "rate_limited" });
    expect(await cards.get(URL_OF(2))).toMatchObject({ ok: false, error: "rate_limited" });
    expect(reads).toBe(1);
  });

  test("a read that never answers is given up on at the limit: its requests are aborted and the card couldn't load", async () => {
    const signals: AbortSignal[] = [];
    const read: ForgejoRefReader = (_ref, signal) => {
      if (signal) signals.push(signal);
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const cards = createRefCards({ run: noCli, avatar: async () => null, forgejo: read, bitbucketTimeoutMs: LIMIT_MS });
    const started = Date.now();
    expect(await cards.get(URL_OF(3))).toMatchObject({ ok: false, error: "unavailable" });
    expect(Date.now() - started).toBeLessThan(LIMIT_MS + 2_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  test("the reader gets the host, owner, repo and number the link names", async () => {
    learnForgejoHosts(["git.acme.com"]);
    const seen: unknown[] = [];
    const cards = createRefCards({ run: noCli, avatar: async () => null, forgejo: async (ref) => (seen.push(ref), card(ref)) });
    await cards.get("https://git.acme.com/acme/billing/pulls/12/files");
    expect(seen).toEqual([{ host: "git.acme.com", owner: "acme", repo: "billing", number: 12 }]);
  });

  test("an issue and a pull request of one number are one item, as on Forgejo", async () => {
    let reads = 0;
    const cards = createRefCards({ run: noCli, avatar: async () => null, forgejo: async (ref) => (reads++, card(ref)) });
    await cards.get("https://codeberg.org/acme/billing/pulls/5");
    await cards.get("https://codeberg.org/acme/billing/issues/5");
    expect(reads).toBe(1);
  });
});

describe("a Forgejo that requires sign-in, with no token configured", () => {
  test("the card says to sign in (add a token), not that the repository is hidden", async () => {
    // The instance's own answer to any anonymous call.
    const runtime = {
      async runCommand() { throw new Error("no CLI"); },
      fetch: (async () => new Response(JSON.stringify({ message: "Only signed in user is allowed to call APIs." }), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch,
    };
    const cards = createRefCards({ run: noCli, avatar: async () => null, forgejo: (ref, signal) => fetchFjCard(runtime, ref, signal) });
    expect(await cards.get(URL_OF(1))).toMatchObject({ ok: false, error: "signed_out" });
  });

  test("with a token, the same 403 is the account being refused, not a missing sign-in", async () => {
    const runtime = {
      async runCommand() { throw new Error("no CLI"); },
      forgejoToken: () => "t",
      fetch: (async () => new Response(JSON.stringify({ message: "token does not have at least one of required scope(s): [read:repository]" }), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch,
    };
    const cards = createRefCards({ run: noCli, avatar: async () => null, forgejo: (ref, signal) => fetchFjCard(runtime, ref, signal) });
    expect(await cards.get(URL_OF(2))).toMatchObject({ ok: false, error: "not_found" });
  });
});
