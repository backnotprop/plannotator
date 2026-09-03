import type { Origin } from "@plannotator/shared/agents";

/**
 * Whether the `plannotator review` CLI's decision consumer delivers
 * approve-time feedback for this origin (decision-control spec §6.4).
 *
 * Review has no `--gate/--json/--hook` triad, so unlike
 * `supportsAnnotateApprovalNotes` this is keyed on the origin's CONSUMER, not
 * on flags. Every origin routed through this CLI shares the one stdout relay
 * (`composeReviewApprovedMessage` at the approved branch): Claude Code reads
 * the output directly, and the amp/droid plugins shell out to
 * `plannotator review` and relay stdout verbatim, so they inherit the same
 * delivery. That is why this currently returns true uniformly — the function
 * exists as the seam where an origin whose relay drops approve-time output
 * would be keyed off, so the advert can never outrun delivery for it
 * (`reviewDecision.test.ts` pins the client half of that contract).
 */
export function supportsReviewApprovalNotes(_origin: Origin | undefined): boolean {
  return true;
}
