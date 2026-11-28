/**
 * Who gets Code review's one-time offer (approval "inbox-code-review-offer": "for people who already use the Inbox").
 *
 * What regresses: a brand-new user seeing it on their first day (or on a later day, once their Inbox has been used);
 * someone who had the Inbox before this release not getting it, or getting it twice; a person who decided Code review
 * being marked; a later start deciding again over the first start's decision.
 */
import { describe, expect, test } from "bun:test";
import { codeReviewOfferAtStart, codeReviewOfferDue, type CodeReviewOfferSaved } from "./inbox-code-review-offer";

const START = "2026-11-24T09:00:00.000Z";
const LATER = "2026-11-25T09:00:00.000Z";

/** The record after a run of release starts, as the server keeps it: each start may mark, the first claim stamps `shownAt`. */
function starts(runs: readonly { usedBefore: boolean; decided?: boolean }[], saved?: CodeReviewOfferSaved): CodeReviewOfferSaved | undefined {
  let record = saved;
  runs.forEach((run, i) => {
    record = codeReviewOfferAtStart(record, run.decided ?? false, run.usedBefore, i === 0 ? START : LATER) ?? record;
  });
  return record;
}

describe("Code review's offer: who it is for", () => {
  test("a new user (no Inbox ran here before this release): no offer on day 0, nor at any later start once the Inbox has been used", () => {
    const record = starts([{ usedBefore: false }, { usedBefore: true }, { usedBefore: true }]);
    expect(codeReviewOfferDue(record)).toBe(false);
    expect(record).toEqual({ freshAt: START });
  });

  test("someone who had the Inbox before this release: due once, and the claim's stamp is never replaced by a later start", () => {
    const record = starts([{ usedBefore: true }]);
    expect(codeReviewOfferDue(record)).toBe(true);
    // The server's claim keeps the record and stamps it once (inbox.ts `claimReveal`); the line opens it only while unshown.
    const claimed = { ...record, shownAt: LATER, key: "page-key-aaaa" };
    expect(starts([{ usedBefore: true }, { usedBefore: true }], claimed)).toEqual(claimed);
  });

  test("a record from before (an earlier claim with no mark) is kept: never due again", () => {
    const shown = { shownAt: "2026-11-08T10:00:00.000Z", key: "page-key-bbbb" };
    const record = starts([{ usedBefore: true }], shown);
    expect(record).toEqual(shown);
    expect(codeReviewOfferDue(record)).toBe(false);
  });

  test("Code review decided by the person (on or off): nothing is written for them", () => {
    expect(codeReviewOfferAtStart(undefined, true, true, START)).toBeNull();
    expect(codeReviewOfferAtStart(undefined, true, false, START)).toBeNull();
  });
});
