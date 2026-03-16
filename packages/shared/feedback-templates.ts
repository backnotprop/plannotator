/**
 * Shared feedback templates for all agent integrations.
 *
 * The plan deny template was tuned in #224 / commit 3dca977 to use strong
 * directive framing — Claude was ignoring softer phrasing.
 */

import {
  formatIterationContext,
  formatQAContext,
  type ReviewIteration,
  type ClarificationQuestion,
  type QuestionAnswer,
} from "./questions";

export interface PlanDenyFeedbackOptions {
  planFilePath?: string;
  /** Previous review iterations for context persistence */
  previousIterations?: ReviewIteration[];
  /** Clarification Q&A from the current iteration */
  clarificationQuestions?: ClarificationQuestion[];
  clarificationAnswers?: QuestionAnswer[];
}

export const planDenyFeedback = (
  feedback: string,
  toolName: string = "ExitPlanMode",
  options?: PlanDenyFeedbackOptions,
): string => {
  const planFileRule = options?.planFilePath
    ? `- Read ${options.planFilePath} to see the current plan before editing it.\n`
    : "";

  // Build accumulated context from previous iterations
  const iterationContext = options?.previousIterations?.length
    ? `\n\n${formatIterationContext(options.previousIterations)}`
    : "";

  // Build Q&A context from current iteration
  const qaContext =
    options?.clarificationQuestions?.length
      ? `\n\n${formatQAContext(options.clarificationQuestions, options.clarificationAnswers || [])}`
      : "";

  return `YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before calling ${toolName} again.\n\nRules:\n${planFileRule}- Use the Edit tool to make targeted changes to the plan — do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n\n${feedback || "Plan changes requested"}${qaContext}${iterationContext}`;
};

/**
 * Feedback template for "approve with notes" — the plan is approved and the
 * agent should proceed with implementation, but the user attached annotations
 * that should be considered (not blocking).
 */
export const planApproveWithNotesFeedback = (
  feedback: string,
  options?: {
    clarificationQuestions?: ClarificationQuestion[];
    clarificationAnswers?: QuestionAnswer[];
  },
): string => {
  const qaContext =
    options?.clarificationQuestions?.length
      ? `\n\n${formatQAContext(options.clarificationQuestions, options.clarificationAnswers || [])}`
      : "";

  return `Plan approved with notes!\n\n## Implementation Notes\n\nThe user approved your plan but added the following notes to consider during implementation:\n\n${feedback}${qaContext}\n\nProceed with implementation, incorporating these notes where applicable.`;
};
