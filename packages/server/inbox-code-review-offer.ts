/**
 * Who gets Code review's one-time offer ("A new way to review", approval "inbox-code-review-offer": "for people who
 * already use the Inbox"). Pure, so a test needs no Inbox.
 *
 * Decided as the tab icon dialog's is (packages/server/inbox.ts, `tab_icon`): at the first release start of the version
 * that shows it (`CODE_REVIEW_OFFER_SHOWN`), someone who used an earlier Inbox (`inboxUsedBefore`) is marked due
 * (`dueAt`), and a fresh install is marked fresh (`freshAt`) and never sees it, on day 0 or after. Someone who already
 * decided Code review (config.json `inboxCodeReview` set, on or off) is never asked, so nothing is written for them. A
 * record already there (an earlier claim's `shownAt`) is kept as it is: the decision is made once.
 */
import type { PlannotatorConfig } from "@plannotator/shared/config";

export type CodeReviewOfferSaved = NonNullable<NonNullable<PlannotatorConfig["inboxReveals"]>["code_review"]>;

/**
 * At a release start while the offer is shown: the record to write, or null when there is nothing to decide (a record
 * already, or Code review decided). `usedBefore`: an Inbox ran here before this start. `at`: now, as an ISO string.
 */
export function codeReviewOfferAtStart(saved: CodeReviewOfferSaved | undefined, decided: boolean, usedBefore: boolean, at: string): CodeReviewOfferSaved | null {
  if (saved !== undefined || decided) return null;
  return usedBefore ? { dueAt: at } : { freshAt: at };
}

/** Marked due at a release start (someone who used an earlier Inbox). Whether it is still unshown is the line's to read. */
export function codeReviewOfferDue(saved: CodeReviewOfferSaved | undefined): boolean {
  return typeof saved?.dueAt === "string" && saved.dueAt !== "";
}
