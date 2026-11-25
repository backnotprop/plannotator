/**
 * Code review's "Semantic changes" switch (Settings › Analysis, config.json
 * `reviewAnalysis.semanticDiff`, on unless set) in the Inbox. Off, no
 * semantic diff is drawn anywhere: code review, the Inbox's PR page and its
 * guided reviews. The Inbox may run on another host than code review
 * (127.0.0.1, the tailnet name), where the two share no cookies, so the
 * Inbox reads and writes config.json through GET and POST
 * /api/inbox/settings `review_analysis` (packages/inbox/reviewAnalysis.ts).
 *
 * On the wire the field is `semantic_diff`: true, false, or null while never
 * chosen. Call flow is not here: the Inbox does not run it, and turning it on
 * in code review is also consent to its runtime install.
 */
import type { PlannotatorConfig } from "./config";

export interface InboxReviewAnalysis {
  semantic_diff: boolean | null;
}

/** config.json's `reviewAnalysis` as the wire names it; a value never chosen (or not a boolean) is null. */
export function inboxReviewAnalysisOf(reviewAnalysis: PlannotatorConfig["reviewAnalysis"] | undefined): InboxReviewAnalysis {
  const value = reviewAnalysis?.semanticDiff;
  return { semantic_diff: typeof value === "boolean" ? value : null };
}

export type InboxReviewAnalysisParse =
  | { ok: true; reviewAnalysis: { semanticDiff: boolean } }
  | { ok: false; field: string; error: string };

/** A change to save: `review_analysis` with `semantic_diff`, a boolean. Nothing else is accepted. */
export function parseInboxReviewAnalysisChange(value: unknown): InboxReviewAnalysisParse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, field: "review_analysis", error: "review_analysis: { semantic_diff: true or false }." };
  }
  for (const key of Object.keys(value)) {
    if (key !== "semantic_diff") return { ok: false, field: `review_analysis.${key}`, error: `review_analysis.${key}: not saved here; use semantic_diff.` };
  }
  const semantic = (value as { semantic_diff?: unknown }).semantic_diff;
  if (typeof semantic !== "boolean") return { ok: false, field: "review_analysis.semantic_diff", error: "review_analysis.semantic_diff: true or false." };
  return { ok: true, reviewAnalysis: { semanticDiff: semantic } };
}
