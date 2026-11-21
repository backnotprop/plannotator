/**
 * Qwen Code plan review: the PermissionRequest hook on `exit_plan_mode`.
 *
 * Qwen Code fires PermissionRequest before it shows its own confirmation for
 * a tool, with the Claude Code-style payload: `hook_event_name`,
 * `tool_name`, `tool_input` (`exit_plan_mode` carries the plan inline as
 * `tool_input.plan`), `session_id`, `transcript_path`, `cwd`.
 *
 * The pair (PermissionRequest, exit_plan_mode) is Qwen's alone: Claude Code
 * names the tool `ExitPlanMode`, Gemini CLI sends `BeforeTool`, Mistral Vibe
 * sends `pre_tool`. So the hook needs no environment variable to know it runs
 * under Qwen. (The NonoElRobot fork detected Qwen through `QWEN_CODE`, which
 * Qwen sets only for its shell tool, not for hooks.)
 *
 * What the decision does in Qwen Code:
 * - deny: Qwen cancels the call and hands `message` to the model as the tool
 *   error, so the feedback reaches the agent at once and it stays in plan mode.
 * - allow: Qwen never lets a hook approve a tool that needs the person
 *   (`exit_plan_mode` is one), so it still shows its own plan confirmation in
 *   the terminal. The person approves there a second time. Approval notes
 *   cannot travel with an allow, so the review offers none.
 */

import { composePlanDeniedMessage, getPlanToolName } from "@plannotator/shared/prompts";

export const QWEN_PLAN_TOOL = "exit_plan_mode";

/** True for Qwen Code's PermissionRequest hook event on `exit_plan_mode`. */
export function isQwenPlanPermissionRequest(event: Record<string, unknown> | null | undefined): boolean {
  return (
    !!event &&
    event.hook_event_name === "PermissionRequest" &&
    event.tool_name === QWEN_PLAN_TOOL
  );
}

/** The plan Qwen sent inline, or "" when there is none. */
export function qwenPlanFromEvent(event: Record<string, unknown>): string {
  const input = event.tool_input;
  if (!input || typeof input !== "object") return "";
  const plan = (input as { plan?: unknown }).plan;
  return typeof plan === "string" ? plan : "";
}

export interface QwenPlanDecision {
  approved: boolean;
  feedback?: string;
  answersOnly?: boolean;
}

/** The hook's stdout for a review decision, in Qwen's PermissionRequest shape. */
export function qwenPlanHookOutput(result: QwenPlanDecision): string {
  if (result.approved) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: composePlanDeniedMessage("qwen-code", undefined, {
          toolName: getPlanToolName("qwen-code"),
          planFileRule: "",
          feedback: result.feedback || "Plan changes requested",
        }, { answersOnly: result.answersOnly }),
      },
    },
  });
}
