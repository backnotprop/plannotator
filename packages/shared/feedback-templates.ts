/**
 * Shared feedback templates for all agent integrations.
 *
 * The plan deny template was tuned in #224 / commit 3dca977 to use strong
 * directive framing — Claude was ignoring softer phrasing.
 *
 * IMPORTANT: This module is imported by packages/ui/utils/parser.ts which is
 * bundled into the browser SPA. It must NOT import from ./prompts or ./config
 * (which depend on node:fs, node:os, node:child_process). Keep it self-contained.
 *
 * Server-side call sites use getPlanDeniedPrompt() from ./prompts directly.
 * This module is only kept for the browser's wrapFeedbackForAgent clipboard feature.
 */

export interface PlanDenyFeedbackOptions {
  planFilePath?: string;
}

export const planDenyFeedback = (
  feedback: string,
  toolName: string = "ExitPlanMode",
  options?: PlanDenyFeedbackOptions,
): string => {
  const planFileRule = options?.planFilePath
    ? `- Your plan is saved at: ${options.planFilePath}\n  You can edit this file to make targeted changes, then pass its path to ${toolName}.\n`
    : "";

  return `YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before calling ${toolName} again.\n\nRules:\n${planFileRule}- Do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n\n${feedback || "Plan changes requested"}`;
};
