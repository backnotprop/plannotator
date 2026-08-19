import type { AnnotateOutcome } from "./strict-annotate-result";

export type { AnnotateOutcome } from "./strict-annotate-result";

export interface AnnotateOutputOptions {
  hook: boolean;
  json: boolean;
}

export interface AnnotateApprovalCapabilityOptions extends AnnotateOutputOptions {
  gate: boolean;
}

export interface AnnotateClientLeaseCapabilityOptions extends AnnotateApprovalCapabilityOptions {
  /** True for remote/shared sessions, where a lost tab connection is expected and not abandonment. */
  isRemote: boolean;
}

const APPROVED_PLAINTEXT_MARKER = "The user approved.";

export function supportsAnnotateApprovalNotes(
  options: AnnotateApprovalCapabilityOptions,
): boolean {
  return options.gate && options.json && !options.hook;
}

/**
 * Local direct structured annotate gates (`--gate --json`, not `--hook`, not
 * a remote/shared session) are the only transport where a tab's abandonment
 * can be safely resolved automatically — the caller is already blocked on a
 * structured decision and no other protocol (hook JSON, plaintext) depends on
 * the exact timing of the response.
 */
export function supportsAnnotateClientLease(
  options: AnnotateClientLeaseCapabilityOptions,
): boolean {
  return options.gate && options.json && !options.hook && !options.isRemote;
}

export function formatAnnotateOutcome(
  result: AnnotateOutcome,
  options: AnnotateOutputOptions,
): string | null {
  if (options.hook) {
    if (result.approved || result.exit) return null;
    return result.feedback
      ? JSON.stringify({ decision: "block", reason: result.feedback })
      : null;
  }

  if (options.json) {
    if (result.approved) {
      return JSON.stringify({
        decision: "approved",
        ...(result.feedback ? { feedback: result.feedback } : {}),
      });
    }
    if (result.exit) return JSON.stringify({ decision: "dismissed" });
    return JSON.stringify({
      decision: "annotated",
      feedback: result.feedback || "",
    });
  }

  if (result.exit) return null;
  if (result.approved) return APPROVED_PLAINTEXT_MARKER;
  return result.feedback || null;
}

export function createAnnotateOutcomeEmitter(
  options: AnnotateOutputOptions,
): (result: AnnotateOutcome) => void {
  return (result) => {
    const output = formatAnnotateOutcome(result, options);
    if (output !== null) console.log(output);
  };
}
