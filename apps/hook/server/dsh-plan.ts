import type { PlannotatorConfig } from "@plannotator/shared/config";
import {
  composePlanDeniedMessage,
  getPlanApprovedWithNotesPrompt,
  getPlanToolName,
} from "@plannotator/shared/prompts";

export interface DshPlanInput {
  plan: string;
  timeoutSeconds: number | null;
  cwd?: string;
}

export interface DshPlanDecision {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  answersOnly?: boolean;
}

export interface DshPlanOutput {
  approved: boolean;
  feedback?: string;
  message?: string;
  savedPath?: string;
  answersOnly?: true;
}

export function parseDshPlanInput(
  inputJson: string,
): { ok: true; input: DshPlanInput } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch (error) {
    return { ok: false, error: `Failed to parse dsh-plan input: ${error instanceof Error ? error.message : String(error)}` };
  }
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const plan = typeof record.plan === "string" ? record.plan : "";
  if (!plan.trim()) return { ok: false, error: "No plan content in dsh-plan input" };
  const timeout = record.timeoutSeconds;
  const timeoutSeconds = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : null;
  const cwd = typeof record.cwd === "string" && record.cwd ? record.cwd : undefined;
  return { ok: true, input: { plan, timeoutSeconds, ...(cwd && { cwd }) } };
}

export function dshPlanTimeoutFeedback(timeoutSeconds: number): string {
  return `[Plannotator] No response within ${timeoutSeconds} seconds. Port released automatically. Please call ${getPlanToolName("dsh")} again.`;
}

export function composeDshPlanOutput(
  result: DshPlanDecision,
  config?: PlannotatorConfig,
): DshPlanOutput {
  const savedPath = result.savedPath ? { savedPath: result.savedPath } : {};
  if (result.approved) {
    const notes = result.feedback?.trim() ? result.feedback : undefined;
    if (!notes) return { approved: true, ...savedPath };
    return {
      approved: true,
      feedback: notes,
      message: getPlanApprovedWithNotesPrompt("dsh", config, {
        planFilePath: result.savedPath ?? "the approved plan",
        doneMsg: result.savedPath ? ` Saved to: ${result.savedPath}` : "",
        feedback: notes,
      }).trim(),
      ...savedPath,
    };
  }
  const answersOnly = result.answersOnly === true;
  return {
    approved: false,
    ...(result.feedback && { feedback: result.feedback }),
    message: composePlanDeniedMessage("dsh", config, {
      toolName: getPlanToolName("dsh"),
      planFileRule: "",
      feedback: result.feedback || "Plan changes requested",
    }, { answersOnly }),
    ...savedPath,
    ...(answersOnly && { answersOnly: true as const }),
  };
}
