export interface AnnotateDecisionSettler<TDecision> {
  settle: (decision: TDecision) => boolean;
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

export function isNothingToSendFeedbackBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.nothingToSend !== true) return false;
  const empty = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0);
  return empty(b.annotations) && empty(b.codeAnnotations);
}
