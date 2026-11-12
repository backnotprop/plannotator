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

export const applyFeedbackTemplate = (
  template: string,
  vars: Record<string, string | undefined>,
): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = vars[key];
    return val !== undefined ? val : match;
  });

export interface AnnotateFeedbackTemplates {
  fileFeedback?: string;
  messageFeedback?: string;
}

export type ClipboardFeedbackContext =
  | { mode: "plan-review" }
  | { mode: "annotate-file"; template?: string; filePath: string; fileHeader?: string }
  | { mode: "annotate-message"; template?: string };

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
