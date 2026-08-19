import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  getPlanApprovedPrompt,
  getPlanApprovedWithNotesPrompt,
  getPlanDeniedPrompt,
  getPlanToolName,
} from "@plannotator/shared/prompts";
import { sanitizeTag } from "@plannotator/shared/project";
import {
  applyEdits,
  formatWithLineNumbers,
  getPlanBackingPath,
  type PlanEdit,
  validateEdits,
} from "./plan-edits";
import {
  shouldRejectSubmitPlanForAgent,
  shouldStartImplementationForAgent,
  type NormalizedWorkflowOptions,
} from "./workflow";

const MAX_PLAN_SIZE = 5 * 1024 * 1024;

export interface SubmitPlanReviewResult {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
}

export interface SubmitPlanInvocation {
  edits: PlanEdit[] | undefined;
  invokingAgent?: string;
  sessionId: string;
  abortSignal?: AbortSignal;
  directory: string;
  workflowOptions: NormalizedWorkflowOptions;
}

export interface SubmitPlanHost {
  reviewPlan(input: {
    planContent: string;
    abortSignal?: AbortSignal;
  }): Promise<SubmitPlanReviewResult>;
  resolveTargetAgent(input: {
    requestedAgent?: string;
    directory: string;
    delivery: "plan-approval";
  }): Promise<string | undefined>;
  sendApprovalHandoff(input: {
    sessionId: string;
    targetAgent: string;
    text: string;
  }): Promise<void>;
}

export async function executeSubmitPlan(
  invocation: SubmitPlanInvocation,
  host: SubmitPlanHost,
): Promise<string> {
  if (shouldRejectSubmitPlanForAgent(invocation.invokingAgent, invocation.workflowOptions)) {
    return `Plannotator is configured for plan-agent mode. submit_plan can only be called by: ${invocation.workflowOptions.planningAgents.join(", ")}.

Use /plannotator-last or /plannotator-annotate for manual review, or set workflow to all-agents to allow broader submit_plan access.`;
  }

  invocation.abortSignal?.throwIfAborted();

  if (!invocation.edits || invocation.edits.length === 0) {
    return "Error: No edits provided. Pass at least one edit with start and content.";
  }

  const project = sanitizeTag(path.basename(invocation.directory)) || "_unknown";
  const backingPath = getPlanBackingPath(project);
  mkdirSync(path.dirname(backingPath), { recursive: true });

  const existingContent = existsSync(backingPath)
    ? readFileSync(backingPath, "utf-8")
    : "";
  const existingLines = existingContent ? existingContent.split("\n") : [];
  const validationError = validateEdits(existingLines, invocation.edits);
  if (validationError) return `Error: ${validationError}`;

  let resultLines: string[];
  try {
    resultLines = applyEdits(existingLines, invocation.edits);
  } catch (error) {
    return `Error applying edits: ${error instanceof Error ? error.message : String(error)}`;
  }

  const planContent = resultLines.join("\n");
  if (planContent.length > MAX_PLAN_SIZE) {
    return `Error: Plan content exceeds the maximum size of ${MAX_PLAN_SIZE / (1024 * 1024)}MB.`;
  }
  if (!planContent.trim()) return "Error: Plan content is empty after applying edits.";

  writeFileSync(backingPath, planContent, "utf-8");

  let reviewResult: SubmitPlanReviewResult;
  try {
    reviewResult = await host.reviewPlan({
      planContent,
      abortSignal: invocation.abortSignal,
    });
  } catch (error) {
    invocation.abortSignal?.throwIfAborted();
    return `[Plannotator] Failed to open plan review: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (!reviewResult.approved) {
    const lineNumberedPlan = formatWithLineNumbers(planContent);
    const totalLines = planContent.split("\n").length;
    return getPlanDeniedPrompt("opencode", undefined, {
      toolName: getPlanToolName("opencode"),
      planFileRule: "",
      feedback: reviewResult.feedback || "Plan changes requested",
    }) + `\n\n## Current Plan (${totalLines} lines)\n\nThe plan below shows the current state with line numbers. Use these exact line numbers in your next \`submit_plan\` call:\n\n\`\`\`\n${lineNumberedPlan}\n\`\`\`\n\nCall \`submit_plan\` with targeted edits to address the feedback above.`;
  }

  try {
    unlinkSync(backingPath);
  } catch {
    // The approved plan may already have been removed.
  }

  const targetAgent = await host.resolveTargetAgent({
    requestedAgent: reviewResult.agentSwitch,
    directory: invocation.directory,
    delivery: "plan-approval",
  });
  const shouldStartImplementation = targetAgent
    ? shouldStartImplementationForAgent(targetAgent, invocation.workflowOptions)
    : false;

  if (targetAgent) {
    try {
      await host.sendApprovalHandoff({
        sessionId: invocation.sessionId,
        targetAgent,
        text: shouldStartImplementation
          ? "Proceed with implementation"
          : "Plan approved. Plan mode remains active; no implementation has been requested.",
      });
    } catch {
      // The session can still be busy while the tool result is being delivered.
    }
  }

  if (reviewResult.feedback) {
    return getPlanApprovedWithNotesPrompt("opencode", undefined, {
      planFilePath: backingPath,
      doneMsg: reviewResult.savedPath ? `Saved to: ${reviewResult.savedPath}` : "",
      feedback: reviewResult.feedback,
      proceedSuffix: shouldStartImplementation
        ? "\n\nProceed with implementation, incorporating these notes where applicable."
        : "",
    });
  }

  return getPlanApprovedPrompt("opencode", undefined, {
    planFilePath: backingPath,
    doneMsg: reviewResult.savedPath ? ` Saved to: ${reviewResult.savedPath}` : "",
  });
}
