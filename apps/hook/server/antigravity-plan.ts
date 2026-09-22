import path from "node:path";
import { getPlanDeniedPrompt } from "@plannotator/shared/prompts";

const PLAN_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Antigravity has no exit-plan tool. Review proposed writes to the current
 * conversation's implementation_plan.md before the file tool executes.
 * Contract: https://www.agy.dev/docs/hooks/#pretooluse
 * null means abstain: unrelated tools must retain their normal permissions.
 */
export function getAntigravityPlan(event: unknown): string | null {
  if (!isRecord(event) || !isRecord(event.toolCall)) {
    throw new Error("Invalid Antigravity toolCall payload.");
  }
  const { name, args } = event.toolCall;
  if (typeof name !== "string" || !PLAN_TOOLS.has(name)) return null;
  if (!isRecord(args) || typeof args.TargetFile !== "string") {
    throw new Error("Antigravity file tool is missing TargetFile.");
  }
  const target = args.TargetFile;
  const filename = path.basename(target);
  if ((process.platform === "win32" ? filename.toLowerCase() : filename) !== "implementation_plan.md") return null;
  if (typeof event.artifactDirectoryPath !== "string" || !path.isAbsolute(event.artifactDirectoryPath) || !path.isAbsolute(target)) {
    throw new Error("Antigravity plan review requires absolute TargetFile and artifactDirectoryPath paths.");
  }
  const expected = path.join(event.artifactDirectoryPath, "implementation_plan.md");
  if (path.relative(expected, target) !== "") return null;

  // Do not approximate Antigravity's fuzzy patch semantics: review exactly
  // what will be written, including revisions, by requiring a full payload.
  if (name !== "write_to_file") {
    throw new Error("Resubmit the complete revised implementation plan with write_to_file (TargetFile unchanged, Overwrite: true, CodeContent: full plan) so Plannotator can review the exact content before it is written.");
  }
  if (typeof args.CodeContent !== "string" || !args.CodeContent.trim()) {
    throw new Error("Antigravity plan write requires non-empty CodeContent.");
  }
  return args.CodeContent;
}

export function formatAntigravityDecision(result: { approved: boolean; feedback?: string }) {
  if (result.approved) {
    return { decision: "allow", ...(result.feedback ? { reason: result.feedback } : {}) };
  }
  return {
    decision: "deny",
    reason: getPlanDeniedPrompt("antigravity", undefined, {
      toolName: "write_to_file",
      planFileRule: "- The rejected write did not run. Resubmit the complete revised plan using the same TargetFile, Overwrite: true, and CodeContent containing the full plan.\n",
      feedback: result.feedback || "Plan changes requested",
    }),
  };
}
