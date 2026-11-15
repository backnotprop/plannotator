/**
 * Bitbucket Cloud reads in the hover cards' lookup keep a CLI's time limit (#3082's rule: nothing stuck freezes the
 * window). What regresses: a slow or stuck api.bitbucket.org holding one of the shared slots past the limit (GitHub and
 * GitLab cards then wait behind it), its requests left running after the card gave up, or the card not saying it
 * couldn't load. No network: the reader is a stand-in that answers only when told, or never.
 */
import { describe, expect, test } from "bun:test";
import { createRefCards, REF_MAX_CONCURRENT, REF_SLOT_HOLD_MS, type BitbucketRefReader, type RefRunner } from "./ref-cards";

const BB = (n: number) => `https://bitbucket.org/acme/billing/pull-requests/${n}`;
const LIMIT_MS = 150;

/** A Bitbucket reader that never answers on its own; it records each read's signal and rejects once that aborts. */
function stuckReader(): { read: BitbucketRefReader; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  const read: BitbucketRefReader = (_ref, signal) => {
    if (signal) signals.push(signal);
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  return { read, signals };
}

describe("Bitbucket card reads have a CLI's time limit", () => {
  test("a read that never answers is given up on at the limit: its requests are aborted and the card couldn't load", async () => {
    const { read, signals } = stuckReader();
    const run: RefRunner = async () => ({ stdout: "", stderr: "", exitCode: 1 });
    const cards = createRefCards({ run, bitbucket: read, bitbucketTimeoutMs: LIMIT_MS, avatar: async () => null });
    const started = Date.now();
    const result = await cards.get(BB(7));
    expect(Date.now() - started).toBeLessThan(LIMIT_MS + 2_000);
    expect(result).toMatchObject({ ok: false, error: "unavailable" });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  test("stuck Bitbucket reads give their slots back at the limit, so a GitHub card asked behind them runs then", async () => {
    expect(REF_MAX_CONCURRENT).toBe(2);
    const { read, signals } = stuckReader();
    const ghCalls: string[][] = [];
    const run: RefRunner = async (cli, args) => {
      ghCalls.push([cli, ...args]);
      return { stdout: "", stderr: "not found", exitCode: 1 };
    };
    const cards = createRefCards({ run, bitbucket: read, bitbucketTimeoutMs: LIMIT_MS, avatar: async () => null });
    // Both slots taken by Bitbucket reads that never answer.
    const stuck = [cards.get(BB(1)), cards.get(BB(2))];
    const github = cards.get("https://github.com/acme/web/pull/3");
    await new Promise((r) => setTimeout(r, LIMIT_MS / 3));
    expect(ghCalls).toHaveLength(0);
    const started = Date.now();
    await github;
    // Freed at the limit, never only by the slots' own last resort.
    expect(Date.now() - started).toBeLessThan(REF_SLOT_HOLD_MS / 2);
    expect(ghCalls.length).toBeGreaterThan(0);
    expect(ghCalls[0]![0]).toBe("gh");
    for (const result of await Promise.all(stuck)) expect(result).toMatchObject({ ok: false, error: "unavailable" });
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
  });

  test("a read that answers inside the limit is a card, and its signal is never aborted", async () => {
    const signals: AbortSignal[] = [];
    const read: BitbucketRefReader = async (ref, signal) => {
      if (signal) signals.push(signal);
      return {
        platform: "bitbucket", kind: "pull", repo: `${ref.workspace}/${ref.repo}`, number: ref.number, url: BB(ref.number),
        title: "Retry invoices", state: "open", author: null, createdAt: "", updatedAt: "", closedAt: null, labels: [], assignees: [],
        comments: 0, body: "", bodyCut: false, lastComment: null, linked: [],
        pull: { base: "main", head: "retries", additions: 0, deletions: 0, files: 0, review: null, checks: null },
      };
    };
    const run: RefRunner = async () => ({ stdout: "", stderr: "", exitCode: 1 });
    const cards = createRefCards({ run, bitbucket: read, bitbucketTimeoutMs: LIMIT_MS, avatar: async () => null });
    const result = await cards.get(BB(9));
    expect(result).toMatchObject({ ok: true, data: { title: "Retry invoices", number: 9 } });
    await new Promise((r) => setTimeout(r, LIMIT_MS + 50));
    expect(signals[0]!.aborted).toBe(false);
  });
});
