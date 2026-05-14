import {
  buildPlanFileRule,
  getPlanDeniedPrompt,
  getPlanToolName,
} from "@plannotator/shared/prompts";
import type { Origin } from "@plannotator/shared/agents";

export type PlanDecisionResult = {
  approved: boolean;
  feedback?: string;
  permissionMode?: string;
  clearContextNudge?: boolean;
  deferToNativeForClear?: boolean;
};

export type ClaudeHookEventName = "PreToolUse" | "PermissionRequest";

export function normalizeClaudeHookEventName(value: unknown): ClaudeHookEventName {
  return value === "PreToolUse" ? "PreToolUse" : "PermissionRequest";
}

function clearContextSystemMessage(): string {
  return "Plannotator requested bypass mode. Hooks cannot clear context. Run /clear before continuing if you want a fresh implementation session.";
}

export function formatClaudePlanHookOutput(options: {
  result: PlanDecisionResult;
  hookEventName: ClaudeHookEventName;
  toolName: string;
  detectedOrigin: Origin;
  nativeClearEnabled?: boolean;
  planFilename?: string;
}): Record<string, unknown> {
  const { result, hookEventName, toolName, detectedOrigin, nativeClearEnabled, planFilename } = options;
  const isExitPlanMode = toolName === "ExitPlanMode";

  if (result.approved && result.deferToNativeForClear && isExitPlanMode) {
    if (hookEventName === "PreToolUse" && nativeClearEnabled) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
        },
      };
    }

    result.clearContextNudge = true;
    result.permissionMode ||= "bypassPermissions";
  }

  if (hookEventName === "PreToolUse") {
    if (result.approved) {
      return {
        ...(result.clearContextNudge && { systemMessage: clearContextSystemMessage() }),
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: getPlanDeniedPrompt(detectedOrigin, undefined, {
          toolName: getPlanToolName(detectedOrigin),
          planFileRule: buildPlanFileRule(getPlanToolName(detectedOrigin), planFilename),
          feedback: result.feedback || "Plan changes requested",
        }),
      },
    };
  }

  if (result.approved) {
    const updatedPermissions = [];
    if (result.permissionMode) {
      updatedPermissions.push({
        type: "setMode",
        mode: result.permissionMode,
        destination: "session",
      });
    }

    return {
      ...(result.clearContextNudge && { systemMessage: clearContextSystemMessage() }),
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          ...(updatedPermissions.length > 0 && { updatedPermissions }),
        },
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: getPlanDeniedPrompt(detectedOrigin, undefined, {
          toolName: getPlanToolName(detectedOrigin),
          planFileRule: "",
          feedback: result.feedback || "Plan changes requested",
        }),
      },
    },
  };
}
