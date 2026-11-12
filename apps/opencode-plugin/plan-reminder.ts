export const STRICT_PLAN_REMINDER_REPLACEMENT = `<system-reminder>
# Plan Mode - System Reminder

CRITICAL: Plan mode ACTIVE. You are in a PLANNING phase. The ONLY file modifications
allowed are writing or editing markdown files (.md) - plans, specs, documentation, etc.
All other file edits, code modifications, and system changes are STRICTLY FORBIDDEN.
Do NOT use shell commands to manipulate non-markdown files. Commands may ONLY read/inspect.

Use submit_plan to submit the completed plan for user review. Do not proceed with
implementation until the plan is approved.
</system-reminder>`;

const WRAPPER_START = "<system-reminder>";
const WRAPPER_END = "</system-reminder>";

const PLAN_DIRECTORY_LINE = /^\S.*[\\/]\.opencode[\\/]plans?[\\/]?$/;

function wrapped(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(WRAPPER_START) && trimmed.endsWith(WRAPPER_END);
}

export function isOpenCode2PlanReminder(text: string): boolean {
  if (!wrapped(text)) return false;
  if (/\bno longer in plan mode\b/i.test(text)) return false;
  return /\byou are in plan mode\b/i.test(text);
}

function planDirectoryOf(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (PLAN_DIRECTORY_LINE.test(trimmed)) return trimmed;
  }
  return undefined;
}

export function openCode2PlanReminder(directory: string | undefined): string {
  const saveRule = directory
    ? `\n\nIf the user explicitly asks you to save a plan file, write it only in:\n${directory}`
    : "";
  return `${WRAPPER_START}
# Plan Mode - System Reminder

Plan mode is active. Explore and read the codebase, ask the user when you need their input, and work out the plan. Do not modify files, and do not ask a subagent to.

When the plan is ready, submit it with the submit_plan tool: it opens Plannotator's review, where the user approves the plan or asks for changes. submit_plan keeps its own copy of the plan, so it is not a plan file you create, and it is always allowed in Plan mode. Submit the plan with submit_plan rather than only writing it out in the conversation.${saveRule}

Do not implement changes until the plan is approved. If the user asks you to implement before then, tell them to approve the plan in Plannotator or switch agents.
${WRAPPER_END}`;
}

export function planReminderReplacement(text: string): string | undefined {
  if (isOpenCode2PlanReminder(text)) return openCode2PlanReminder(planDirectoryOf(text));
  if (wrapped(text) && text.includes("STRICTLY FORBIDDEN")) return STRICT_PLAN_REMINDER_REPLACEMENT;
  return undefined;
}

export function replacePlanModeReminders(messages: unknown[]): void {
  for (const message of messages) {
    if (!message || typeof message !== "object" || Reflect.get(message, "role") !== "user") continue;
    const content = Reflect.get(message, "content");
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || Reflect.get(part, "type") !== "text") continue;
      const text = Reflect.get(part, "text");
      if (typeof text !== "string") continue;
      const replacement = planReminderReplacement(text);
      if (replacement !== undefined && replacement !== text) Reflect.set(part, "text", replacement);
    }
  }
}
