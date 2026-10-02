/**
 * Claude Code Plan Resolver
 *
 * Claude Code fills ExitPlanMode's `plan` from the plan file when it records
 * the assistant message, before any of that message's tools run. When the
 * model edits the plan file and calls ExitPlanMode in the same message, the
 * inline `plan` is the version from before the edit, so the review would show
 * the plan the user already rejected. By the time the PermissionRequest hook
 * fires, the edit has landed, so the file at `planFilePath` is current.
 *
 * Fallback: the inline `plan`, for hosts that send no path or when the file
 * cannot be read.
 */

import { readFileSync } from "node:fs";

interface ClaudePlanToolInput {
  plan?: unknown;
  planFilePath?: unknown;
}

export function resolveClaudePlan(toolInput: ClaudePlanToolInput | undefined): string {
  const inlinePlan = typeof toolInput?.plan === "string" ? toolInput.plan : "";
  const planFilePath = toolInput?.planFilePath;
  if (typeof planFilePath !== "string" || !planFilePath) return inlinePlan;

  try {
    return readFileSync(planFilePath, "utf8") || inlinePlan;
  } catch {
    return inlinePlan;
  }
}
