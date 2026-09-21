import type { Origin } from "@plannotator/shared/agents";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import {
  composeReviewApprovedMessage,
  getReviewDeniedSuffix,
} from "@plannotator/shared/prompts";

interface ReviewOutcome {
  approved: boolean;
  feedback: string;
  annotations: readonly unknown[];
  exit?: boolean;
}

export interface ReviewOutput {
  decision: "approved" | "annotated" | "dismissed";
  /** The plaintext CLI output, excluding its final console newline. */
  message: string;
}

export function buildReviewOutput(
  result: ReviewOutcome,
  origin: Origin | undefined,
  config?: PlannotatorConfig,
): ReviewOutput {
  if (result.exit) {
    return {
      decision: "dismissed",
      message: "Review session closed without feedback.",
    };
  }
  if (result.approved) {
    return {
      decision: "approved",
      message: composeReviewApprovedMessage(origin, result.feedback, config),
    };
  }
  return {
    decision: "annotated",
    // Preserve the newline between the original feedback and suffix console.log
    // calls. PR feedback gets the suffix too; zero-annotation platform status does not.
    message: result.annotations.length > 0
      ? `${result.feedback}\n${getReviewDeniedSuffix(origin, config)}`
      : result.feedback,
  };
}

/**
 * Whether this CLI's review consumer delivers approval notes for the origin.
 * Direct review renders notes in both plaintext and JSON messages. The OpenCode
 * bridge also checks the plugin's declared support before advertising this.
 */
export function supportsReviewApprovalNotes(_origin: Origin | undefined): boolean {
  return true;
}
