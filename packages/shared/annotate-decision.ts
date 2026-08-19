/**
 * One-shot settlement for an annotate session's decision.
 *
 * An annotate session has several independent decision producers: any connected
 * tab can approve, send feedback, or close, and the client lease can expire on
 * its own (see annotate-client-lease.ts). The awaited promise already ignores a
 * second resolve, which silently hides the problem: a late producer still runs
 * its side effects (deleting the reviewer's draft) and still answers `ok`, so a
 * tab reports success for a decision the caller never received.
 *
 * Routing every producer through one settler makes the winner explicit. A
 * producer that loses must run no side effect and must tell its caller it lost,
 * rather than claiming an outcome that did not happen.
 */
export interface AnnotateDecisionSettler<TDecision> {
  /** Resolve the session with this decision. Returns false if one already won. */
  settle: (decision: TDecision) => boolean;
  /** Whether some producer has already won. */
  isSettled: () => boolean;
}

export function createAnnotateDecisionSettler<TDecision>(
  resolve: (decision: TDecision) => void,
): AnnotateDecisionSettler<TDecision> {
  let settled = false;
  return {
    settle(decision) {
      if (settled) return false;
      settled = true;
      resolve(decision);
      return true;
    },
    isSettled() {
      return settled;
    },
  };
}
