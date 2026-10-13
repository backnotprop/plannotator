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

/**
 * Whether an annotate `/api/feedback` body is a Done with nothing to send.
 *
 * Non-gated annotate has no approve channel, so a Done with no annotations
 * still posts the legacy zero-state sentence as `feedback`: plain CLI stdout,
 * `--json` ("annotated") and the OpenCode/Pi consumers depend on those bytes.
 * The editor additionally marks the body `nothingToSend: true` when the
 * payload it built carries nothing (no annotations, no edits, no attachments),
 * so a host that must not start a turn for it (the Claude Code mod's result
 * record) can tell it apart without reading the English sentence. The flag is
 * honored only together with empty annotation arrays: a body that carries
 * annotations is never "nothing", whatever it claims.
 */
export function isNothingToSendFeedbackBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.nothingToSend !== true) return false;
  const empty = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0);
  return empty(b.annotations) && empty(b.codeAnnotations);
}
