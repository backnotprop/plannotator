/**
 * OpenCode 2's Plan mode reminder, and Plannotator's rewrite of it (#2101).
 *
 * OpenCode 2's built-in Plan plugin (`packages/core/src/plugin/plan.ts` in
 * anomalyco/opencode) keeps a synthetic user message in the history of every
 * Plan agent request, right before the user's prompt. Every OpenCode 2 release
 * (2.0.0 through 2.1.x, checked against 2.0.19 and 2.1.2's binaries) sends:
 *
 *   <system-reminder>
 *   You are in Plan mode. Discuss the plan with the user directly in the
 *   conversation. Do not create or update plan files unless the user explicitly
 *   asks you to; when they do, write them only in:
 *   <home>/.opencode/plan
 *   ...
 *   </system-reminder>
 *
 * Pre-2.0 builds (before 2026-09-02) sent "You are in Plan mode. You may
 * optionally create or update plan documents in: ...". Sitting at the tail of
 * the history, "discuss the plan directly / do not create plan files" beat the
 * system prompt's submit_plan instructions, so the model wrote the plan into
 * the chat and never called submit_plan. This module recognizes that reminder
 * by stable markers (the `<system-reminder>` wrapper and "You are in Plan
 * mode", never one exact sentence) and replaces it with one that tells the
 * model to submit the plan with submit_plan.
 *
 * Cache safety: the replacement depends only on the reminder it replaces (the
 * plan directory is read from it), so the same history gives the same bytes on
 * every request. Order: OpenCode's Plan hook finds its reminder by exact text
 * to decide whether to add one; it is a built-in registered before package
 * plugins, so it reads the history before this rewrite, and the stored message
 * is never changed (only the request's copy). This depends on that order
 * (PluginSupervisor: built-ins, then packages). If OpenCode ever ran package
 * hooks first, its Plan hook would not find its own reminder, add a raw one
 * after our rewrite on every request and persist it, so the bug would return
 * and the history would grow: re-check this when OpenCode's plugin loading
 * changes.
 *
 * OpenCode 1 is not handled here: its plugin (index.ts) rewrites OpenCode 1's
 * "STRICTLY FORBIDDEN" reminder itself, unchanged.
 */

/** The rewrite of an OpenCode 1-style "STRICTLY FORBIDDEN" reminder, as the OpenCode 2 adapter always sent it. */
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

/** A line naming OpenCode's plan directory: `<anything>/.opencode/plan` or `.../plans`, alone on its line. */
const PLAN_DIRECTORY_LINE = /^\S.*[\\/]\.opencode[\\/]plans?[\\/]?$/;

function wrapped(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(WRAPPER_START) && trimmed.endsWith(WRAPPER_END);
}

/** OpenCode 2's Plan mode exit reminder ("You are NO LONGER in Plan mode…"). */
export function isOpenCode2PlanExitReminder(text: string): boolean {
  return wrapped(text) && /\bno longer in plan mode\b/i.test(text);
}

/** OpenCode 2's Plan mode entry reminder (any of its wordings), never its exit reminder. */
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

/**
 * The reminder Plannotator sends in place of OpenCode 2's. Deterministic: the
 * same `directory` always gives the same text. It never says "You are in Plan
 * mode", so it is never recognized (and rewritten) again.
 */
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

/** The text to send in place of `text`, or undefined when it is not a Plan mode reminder Plannotator rewrites. */
export function planReminderReplacement(text: string): string | undefined {
  if (isOpenCode2PlanReminder(text)) return openCode2PlanReminder(planDirectoryOf(text));
  if (wrapped(text) && text.includes("STRICTLY FORBIDDEN")) return STRICT_PLAN_REMINDER_REPLACEMENT;
  return undefined;
}

/** Rewrite every Plan mode reminder among a request's user messages, in place. */
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
