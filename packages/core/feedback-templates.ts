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
 * This module is only kept for the browser's clipboard copy features
 * (wrapFeedbackForAgent / wrapFeedbackForClipboard).
 */

export interface PlanDenyFeedbackOptions {
  planFilePath?: string;
}

export interface AnnotateFileFeedbackOptions {
  filePath: string;
  fileHeader?: "File" | "Folder" | string;
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

export const annotateFileFeedback = (
  feedback: string,
  options: AnnotateFileFeedbackOptions,
): string => {
  const fileHeader = options.fileHeader ?? "File";
  return `# Markdown Annotations\n\n${fileHeader}: ${options.filePath}\n\n${feedback}\n\nPlease address the annotation feedback above.`;
};

export const annotateMessageFeedback = (feedback: string): string =>
  `# Message Annotations\n\n${feedback}\n\nPlease address the annotation feedback above.`;

/**
 * Browser-safe `{{placeholder}}` substitution with the same semantics as
 * resolveTemplate() in @plannotator/shared/prompts: unknown placeholders are
 * left untouched. Used by the clipboard copy paths to apply a server-resolved
 * feedback template without any node: imports.
 */
export const applyFeedbackTemplate = (
  template: string,
  vars: Record<string, string | undefined>,
): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = vars[key];
    return val !== undefined ? val : match;
  });

/**
 * Resolved (config-aware, unsubstituted) feedback templates shipped by the
 * annotate server in the /api/plan payload. Absent outside annotate mode.
 */
export interface AnnotateFeedbackTemplates {
  /** File/folder annotate wrap — placeholders: {{feedback}}, {{filePath}}, {{fileHeader}}. */
  fileFeedback?: string;
  /** Message annotate wrap (annotate-last) — placeholder: {{feedback}}. */
  messageFeedback?: string;
}

export type ClipboardFeedbackContext =
  | { mode: "plan-review" }
  | { mode: "annotate-file"; template?: string; filePath: string; fileHeader?: string }
  | { mode: "annotate-message"; template?: string };

/**
 * Mode-aware wrapper for the clipboard Copy paths (#1107).
 *
 * Plan review keeps the deliberately forceful plan-deny framing. Annotate
 * sessions use the server-resolved template when the server shipped one
 * (matching what Send Feedback produces, including user-customized
 * prompts.annotate.* templates in ~/.plannotator/config.json), and fall back
 * to the built-in annotate defaults when it did not (e.g. shared/static
 * sessions never enter annotate mode and keep plan-deny behavior).
 */
export const wrapFeedbackForClipboard = (
  feedback: string,
  context: ClipboardFeedbackContext,
): string => {
  if (context.mode === "annotate-file") {
    if (context.template) {
      return applyFeedbackTemplate(context.template, {
        feedback,
        filePath: context.filePath,
        fileHeader: context.fileHeader ?? "File",
      });
    }
    return annotateFileFeedback(feedback, {
      filePath: context.filePath,
      fileHeader: context.fileHeader,
    });
  }
  if (context.mode === "annotate-message") {
    if (context.template) {
      return applyFeedbackTemplate(context.template, { feedback });
    }
    return annotateMessageFeedback(feedback);
  }
  return planDenyFeedback(feedback);
};
