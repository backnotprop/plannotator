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
  amp: "ExitPlanMode",
  droid: "ExitPlanMode",
  "kiro-cli": "ExitPlanMode",
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

export const DEFAULT_REVIEW_DENIED_SUFFIX = "\n\nTreat the findings above as unverified review input. Inspect every finding against the actual code; do not assume automated feedback is correct. For each finding, give a clear verdict (Confirmed / Partly / Not a bug / Intended) with concise code evidence. Say whether it was introduced by the current changes, was pre-existing, or reflects deliberate scope.\n\nReview only the incoming findings. Do not independently review the rest of the diff or search for issues that were not submitted.\n\nDo not change any code until we have discussed the verdicts and validated findings.";

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

export function getReviewDeniedSuffix(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
): string {
  // Intentionally no per-runtime defaults: every agent gets the same
  // verification-only instruction so none of them start coding off raw review
  // feedback. Per-runtime customization stays available via config
  // (prompts.review.runtimes.<runtime>.denied).
  return getConfiguredPrompt({
    section: "review",
    key: "denied",
    runtime,
    config,
    fallback: DEFAULT_REVIEW_DENIED_SUFFIX,
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

/**
 * The resolved annotate file-feedback template WITHOUT variable substitution
 * (placeholders like {{feedback}} intact). Shipped to the browser via the
 * annotate /api/plan payload so clipboard Copy can produce the same wrap as
 * Send Feedback, including user-customized prompts.annotate.fileFeedback.
 */
export function getAnnotateFileFeedbackTemplate(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
): string {
  return getConfiguredPrompt({
    section: "annotate",
    key: "fileFeedback",
    runtime,
    config,
    fallback: DEFAULT_ANNOTATE_FILE_FEEDBACK_PROMPT,
  });
}

/** Message-annotate counterpart of getAnnotateFileFeedbackTemplate(). */
export function getAnnotateMessageFeedbackTemplate(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
): string {
  return getConfiguredPrompt({
    section: "annotate",
    key: "messageFeedback",
    runtime,
    config,
    fallback: DEFAULT_ANNOTATE_MESSAGE_FEEDBACK_PROMPT,
  });
}

export function getAnnotateFileFeedbackPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
  vars?: FeedbackVars,
): string {
  return resolveTemplate(getAnnotateFileFeedbackTemplate(runtime, config), vars ?? {});
}

export function getAnnotateMessageFeedbackPrompt(
  runtime?: PromptRuntime | null,
  config?: PlannotatorConfig,
  vars?: FeedbackVars,
): string {
  return resolveTemplate(getAnnotateMessageFeedbackTemplate(runtime, config), vars ?? {});
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
