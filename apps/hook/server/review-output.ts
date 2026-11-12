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
  platform?: boolean;
}

export interface ReviewOutput {
  decision: "approved" | "annotated" | "dismissed";
  message: string;
}

export function reviewFeedbackWantsSuffix(result: {
  feedback: string;
  annotations: readonly unknown[];
  platform?: boolean;
}): boolean {
  if (result.platform === true) return false;
  return result.annotations.length > 0 || result.feedback.trim() !== "";
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
    message: reviewFeedbackWantsSuffix(result)
      ? `${result.feedback}\n${getReviewDeniedSuffix(origin, config)}`
      : result.feedback,
  };
}

export function supportsReviewApprovalNotes(_origin: Origin | undefined): boolean {
  return true;
}
