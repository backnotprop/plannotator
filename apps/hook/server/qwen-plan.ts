import { composePlanDeniedMessage, getPlanToolName } from "@plannotator/shared/prompts";

export const QWEN_PLAN_TOOL = "exit_plan_mode";

export function isQwenPlanPermissionRequest(event: Record<string, unknown> | null | undefined): boolean {
  return (
    !!event &&
    event.hook_event_name === "PermissionRequest" &&
    event.tool_name === QWEN_PLAN_TOOL
  );
}

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
