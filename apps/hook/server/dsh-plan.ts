/**
 * DeepSeek Harness plan review bridge (`plannotator dsh-plan`).
 *
 * The @plannotator/dsh plugin (apps/dsh-plugin) answers DSH's `exit_plan_mode`
 * review by running this internal subcommand: the plan arrives as JSON on
 * stdin and one JSON line comes back on stdout. The agent-facing text is
 * composed here with the shared prompt templates for the `dsh` runtime, so the
 * plugin never duplicates prompt logic and prompt overrides in config.json
 * apply.
 *
 *   stdin:  { plan: string, timeoutSeconds?: number | null, cwd?: string }
 *   stdout: { approved, feedback?, message?, savedPath?, answersOnly? }
 *
 * `message` on an approval is the approved-with-notes prompt (present only
 * when the reviewer left notes; DSH's own tool result already says the plan
 * was approved). On a denial it is the denied prompt, or the answered prompt
 * when the reviewer only answered the plan's questions.
 */

import type { PlannotatorConfig } from "@plannotator/shared/config";
import {
  composePlanDeniedMessage,
  getPlanApprovedWithNotesPrompt,
  getPlanToolName,
} from "@plannotator/shared/prompts";

export interface DshPlanInput {
  plan: string;
  /** Seconds before the review gives up; null waits until a decision. */
  timeoutSeconds: number | null;
  /** The DSH session's working directory, when the caller sends it. */
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

/** The stdout record for one decision, with the agent-facing message composed. */
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
