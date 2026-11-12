import type { Origin } from "@plannotator/shared/agents";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { getAnnotateApprovedWithNotesPrompt } from "@plannotator/shared/prompts";
import type { AnnotateOutcome } from "./strict-annotate-result";

export type { AnnotateOutcome } from "./strict-annotate-result";

export interface AnnotateOutputOptions {
  hook: boolean;
  json: boolean;
}

export interface AnnotateApprovalCapabilityOptions {
  gate: boolean;
  hook: boolean;
}

export interface AnnotateClientLeaseCapabilityOptions extends AnnotateOutputOptions {
  gate: boolean;
  isRemote: boolean;
}

export interface AnnotateApprovalNotesContext {
  runtime?: Origin;
  context?: string;
  config?: PlannotatorConfig;
}

const APPROVED_PLAINTEXT_MARKER = "The user approved.";

export function supportsAnnotateApprovalNotes(
  options: AnnotateApprovalCapabilityOptions,
): boolean {
  return options.gate && !options.hook;
}

export function supportsAnnotateClientLease(
  options: AnnotateClientLeaseCapabilityOptions,
): boolean {
  return options.gate && options.json && !options.hook && !options.isRemote;
}

export interface AnnotateOutcomeExtra {
  target?: string | readonly string[];
}

export function formatAnnotateOutcome(
  result: AnnotateOutcome,
  options: AnnotateOutputOptions,
  extra: AnnotateApprovalNotesContext & AnnotateOutcomeExtra = {},
): string | null {
  if (options.hook) {
    if (result.approved || result.exit) return null;
    return result.feedback
      ? JSON.stringify({ decision: "block", reason: result.feedback })
      : null;
  }

  if (options.json) {
    const count = Array.isArray(result.annotations) ? { annotationCount: result.annotations.length } : {};
    const target = extra.target === undefined || extra.target.length === 0
      ? {}
      : { target: typeof extra.target === "string" ? extra.target : [...extra.target] };
    if (result.approved) {
      return JSON.stringify({
        decision: "approved",
        ...(result.feedback ? { feedback: result.feedback } : {}),
        ...count,
        ...target,
      });
    }
    if (result.exit) return JSON.stringify({ decision: "dismissed", ...target });
    return JSON.stringify({
      decision: "annotated",
      feedback: result.feedback || "",
      ...(result.nothingToSend === true ? { nothingToSend: true } : {}),
      ...count,
      ...target,
    });
  }

  if (result.exit) return null;
  if (result.approved) {
    const feedback = result.feedback?.trim() ? result.feedback : "";
    if (!feedback) return APPROVED_PLAINTEXT_MARKER;
    return getAnnotateApprovedWithNotesPrompt(extra.runtime, extra.config, {
      context: extra.context,
      feedback,
    });
  }
  return result.feedback || null;
}

export function createAnnotateOutcomeEmitter(
  options: AnnotateOutputOptions,
): (result: AnnotateOutcome, extra?: AnnotateApprovalNotesContext & AnnotateOutcomeExtra) => void {
  return (result, extra) => {
    const output = formatAnnotateOutcome(result, options, extra);
    if (output !== null) console.log(output);
  };
}
