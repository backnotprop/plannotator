import { loadConfig, type PlannotatorConfig, type PromptRuntime } from "./config";

// ─── Template engine ─────────────────────────────────────────────────────────

export function resolveTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = vars[key];
    return val !== undefined ? val : match;
  });
}

// ─── Tool name map ───────────────────────────────────────────────────────────

export const PLAN_TOOL_NAMES: Record<PromptRuntime, string> = {
  "claude-code": "ExitPlanMode",
  opencode: "submit_plan",
  "copilot-cli": "exit_plan_mode",
  pi: "plannotator_submit_plan",
  codex: "ExitPlanMode",
  "gemini-cli": "exit_plan_mode",
};

export function getPlanToolName(runtime?: PromptRuntime | null): string {
  return (runtime && PLAN_TOOL_NAMES[runtime]) || "ExitPlanMode";
}

export function buildPlanFileRule(toolName: string, planFilePath?: string): string {
  if (!planFilePath) return "";
  return `- Your plan is saved at: ${planFilePath}\n  You can edit this file to make targeted changes, then pass its path to ${toolName}.\n`;
}

// ─── Default constants ───────────────────────────────────────────────────────

export const DEFAULT_REVIEW_APPROVED_PROMPT = "# Code Review\n\nCode review completed — no changes requested.";

export const DEFAULT_REVIEW_DENIED_SUFFIX = "\nThe reviewer has identified issues above. You must address all of them.";

export const DEFAULT_PLAN_DENIED_PROMPT =
  "YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before calling {{toolName}} again.\n\nRules:\n{{planFileRule}}- Do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n\n{{feedback}}";

export const DEFAULT_PLAN_APPROVED_PROMPT =
  "Plan approved. You now have full tool access (read, bash, edit, write). Execute the plan in {{planFilePath}}. {{doneMsg}}";

export const DEFAULT_PLAN_APPROVED_WITH_NOTES_PROMPT =
  "Plan approved with notes! You now have full tool access (read, bash, edit, write). Execute the plan in {{planFilePath}}. {{doneMsg}}\n\n## Implementation Notes\n\nThe user approved your plan but added the following notes to consider during implementation:\n\n{{feedback}}\n\nProceed with implementation, incorporating these notes where applicable.";

export const DEFAULT_PLAN_AUTO_APPROVED_PROMPT =
  "Plan auto-approved (non-interactive mode). Execute the plan now.";

export const DEFAULT_ANNOTATE_FILE_FEEDBACK_PROMPT =
  "# Markdown Annotations\n\n{{fileHeader}}: {{filePath}}\n\n{{feedback}}\n\nPlease address the annotation feedback above.";

export const DEFAULT_ANNOTATE_MESSAGE_FEEDBACK_PROMPT =
  "# Message Annotations\n\n{{feedback}}\n\nPlease address the annotation feedback above.";

export const DEFAULT_ANNOTATE_APPROVED_PROMPT = "The user approved.";

// ─── Core resolver ───────────────────────────────────────────────────────────

type PromptSection = "review" | "plan" | "annotate";
type PromptKey = "approved" | "approvedWithNotes" | "autoApproved" | "denied"
  | "fileFeedback" | "messageFeedback";

interface PromptLookupOptions {
  section: PromptSection;
  key: PromptKey;
  runtime?: PromptRuntime | null;
  config?: PlannotatorConfig;
  fallback: string;
  runtimeFallbacks?: Partial<Record<PromptRuntime, string>>;
}

function normalizePrompt(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  return prompt.trim() ? prompt : undefined;
}

export function getConfiguredPrompt(options: PromptLookupOptions): string {
  const resolvedConfig = options.config ?? loadConfig();
  const section = resolvedConfig.prompts?.[options.section];
  const runtimePrompt = options.runtime
    ? normalizePrompt(section?.runtimes?.[options.runtime]?.[options.key])
    : undefined;
  const genericPrompt = normalizePrompt(section?.[options.key]);
  const runtimeFallback = options.runtime
    ? options.runtimeFallbacks?.[options.runtime]
    : undefined;

  return runtimePrompt ?? genericPrompt ?? runtimeFallback ?? options.fallback;
}

type FeedbackVars = Record<string, string | undefined>;

// ─── Review wrappers ─────────────────────────────────────────────────────────

export function getReviewApprovedPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
): string {
  return getConfiguredPrompt({
    section: "review",
    key: "approved",
    runtime,
    config,
    fallback: DEFAULT_REVIEW_APPROVED_PROMPT,
  });
}

const REVIEW_DENIED_RUNTIME_DEFAULTS: Partial<Record<PromptRuntime, string>> = {
  opencode: "\n\nPlease address this feedback.",
  pi: "\n\nPlease address this feedback.",
};

export function getReviewDeniedSuffix(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
): string {
  return getConfiguredPrompt({
    section: "review",
    key: "denied",
    runtime,
    config,
    fallback: DEFAULT_REVIEW_DENIED_SUFFIX,
    runtimeFallbacks: REVIEW_DENIED_RUNTIME_DEFAULTS,
  });
}

// ─── Plan wrappers ───────────────────────────────────────────────────────────

export function getPlanDeniedPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
  vars?: FeedbackVars,
): string {
  const template = getConfiguredPrompt({
    section: "plan",
    key: "denied",
    runtime,
    config,
    fallback: DEFAULT_PLAN_DENIED_PROMPT,
  });
  return resolveTemplate(template, vars ?? {});
}

const PLAN_APPROVED_RUNTIME_DEFAULTS: Partial<Record<PromptRuntime, string>> = {
  opencode: "Plan approved!{{doneMsg}}",
};

export function getPlanApprovedPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
  vars?: FeedbackVars,
): string {
  const template = getConfiguredPrompt({
    section: "plan",
    key: "approved",
    runtime,
    config,
    fallback: DEFAULT_PLAN_APPROVED_PROMPT,
    runtimeFallbacks: PLAN_APPROVED_RUNTIME_DEFAULTS,
  });
  return resolveTemplate(template, vars ?? {});
}

const PLAN_APPROVED_WITH_NOTES_RUNTIME_DEFAULTS: Partial<Record<PromptRuntime, string>> = {
  opencode: "Plan approved with notes!\n{{doneMsg}}\n\n## Implementation Notes\n\nThe user approved your plan but added the following notes to consider during implementation:\n\n{{feedback}}{{proceedSuffix}}",
};

export function getPlanApprovedWithNotesPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
  vars?: FeedbackVars,
): string {
  const template = getConfiguredPrompt({
    section: "plan",
    key: "approvedWithNotes",
    runtime,
    config,
    fallback: DEFAULT_PLAN_APPROVED_WITH_NOTES_PROMPT,
    runtimeFallbacks: PLAN_APPROVED_WITH_NOTES_RUNTIME_DEFAULTS,
  });
  return resolveTemplate(template, { proceedSuffix: "", ...vars });
}

export function getPlanAutoApprovedPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
): string {
  return getConfiguredPrompt({
    section: "plan",
    key: "autoApproved",
    runtime,
    config,
    fallback: DEFAULT_PLAN_AUTO_APPROVED_PROMPT,
  });
}

// ─── Annotate wrappers ──────────────────────────────────────────────────────

export function getAnnotateFileFeedbackPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
  vars?: FeedbackVars,
): string {
  const template = getConfiguredPrompt({
    section: "annotate",
    key: "fileFeedback",
    runtime,
    config,
    fallback: DEFAULT_ANNOTATE_FILE_FEEDBACK_PROMPT,
  });
  return resolveTemplate(template, vars ?? {});
}

export function getAnnotateMessageFeedbackPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
  vars?: FeedbackVars,
): string {
  const template = getConfiguredPrompt({
    section: "annotate",
    key: "messageFeedback",
    runtime,
    config,
    fallback: DEFAULT_ANNOTATE_MESSAGE_FEEDBACK_PROMPT,
  });
  return resolveTemplate(template, vars ?? {});
}

export function getAnnotateApprovedPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
): string {
  return getConfiguredPrompt({
    section: "annotate",
    key: "approved",
    runtime,
    config,
    fallback: DEFAULT_ANNOTATE_APPROVED_PROMPT,
  });
}
