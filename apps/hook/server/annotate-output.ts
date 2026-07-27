import type { AnnotateOutcome } from "./strict-annotate-result";

export type { AnnotateOutcome } from "./strict-annotate-result";

export interface AnnotateOutputOptions {
  hook: boolean;
  json: boolean;
}

export interface AnnotateApprovalCapabilityOptions extends AnnotateOutputOptions {
  gate: boolean;
}

const APPROVED_PLAINTEXT_MARKER = "The user approved.";

export function supportsAnnotateApprovalNotes(
  options: AnnotateApprovalCapabilityOptions,
): boolean {
  return options.gate && options.json && !options.hook;
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
