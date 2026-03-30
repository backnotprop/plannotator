/**
 * Shared feedback templates for all agent integrations.
 *
 * The plan deny template was tuned in #224 / commit 3dca977 to use strong
 * directive framing — Claude was ignoring softer phrasing.
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

  const contextAnchoringInstructions = `\n## Context Anchoring\n\nBefore revising your plan:\n1. Add (or update) a \`## Decisions Log\` section at the bottom of the plan.\n2. For each rejected approach from this feedback, add an entry:\n   - **Rejected:** [brief description of the rejected approach]  **Why:** [reason from this feedback]\n3. Do NOT re-propose approaches already listed in the Decisions Log — it is your cross-session memory.\n`;

  return `YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before calling ${toolName} again.\n\nRules:\n${planFileRule}- Do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n${contextAnchoringInstructions}\n${feedback || "Plan changes requested"}`;
};
