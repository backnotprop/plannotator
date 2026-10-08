import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPlanDeniedPrompt } from "@plannotator/shared/prompts";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

const PLAN_FILE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPlanTarget(target: string, artifactDir?: string, metadata?: Record<string, unknown>): boolean {
  const normTarget = normalizePath(target);
  const filename = path.basename(normTarget);

  // Check 1: Conventional implementation_plan.md artifact
  if (artifactDir) {
    const normArtifactDir = normalizePath(artifactDir);
    const expected = path.join(normArtifactDir, "implementation_plan.md");
    if (normTarget === normalizePath(expected)) return true;

    // Any markdown artifact in artifactDir with RequestFeedback requested or with "plan" in name
    if (normTarget.startsWith(normArtifactDir + path.sep)) {
      if (metadata && (metadata.RequestFeedback === true || metadata.requestFeedback === true)) {
        return true;
      }
      if (filename.includes("plan") && filename.endsWith(".md")) {
        return true;
      }
    }
  }

  // Check 2: Conventional workspace plan directories (.agents/plans/*.md or plans/*.md)
  if (normTarget.includes(`${path.sep}.agents${path.sep}plans${path.sep}`) || normTarget.includes(`${path.sep}plans${path.sep}`)) {
    if (filename.endsWith(".md")) return true;
  }

  return false;
}

export function isAntigravityCliEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  const artifactDir = typeof event.artifactDirectoryPath === "string" ? event.artifactDirectoryPath.replace(/\\/g, "/").toLowerCase() : "";
  const transcript = typeof event.transcriptPath === "string" ? event.transcriptPath.replace(/\\/g, "/").toLowerCase() : "";

  // Reject Antigravity IDE
  if (artifactDir.includes("antigravity-ide") || transcript.includes("antigravity-ide")) {
    return false;
  }

  // Reject Antigravity 2.0 Desktop (.gemini/antigravity/ without -cli or -ide)
  if (
    (artifactDir.includes("/.gemini/antigravity/") && !artifactDir.includes("antigravity-cli")) ||
    (transcript.includes("/.gemini/antigravity/") && !transcript.includes("antigravity-cli"))
  ) {
    return false;
  }

  return true;
}

export interface PlanningLock {
  workspace: string;
  planFile: string;
  status: "in_review" | "denied" | "approved";
  feedback?: string;
  updatedAt: number;
}

const PLANNING_LOCK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getPlanningLockPath(workspace: string): string {
  const norm = normalizePath(workspace);
  const hash = crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
  const lockDir = path.join(getPlannotatorDataDir(), "planning-locks");
  mkdirSync(lockDir, { recursive: true });
  return path.join(lockDir, `${hash}.json`);
}

export function getPlanningLock(workspace: string): PlanningLock | null {
  try {
    const lockPath = getPlanningLockPath(workspace);
    if (!existsSync(lockPath)) return null;
    const content = readFileSync(lockPath, "utf8");
    const lock = JSON.parse(content) as PlanningLock;
    if (Date.now() - lock.updatedAt > PLANNING_LOCK_TTL_MS) {
      rmSync(lockPath, { force: true });
      return null;
    }
    return lock;
  } catch {
    return null;
  }
}

export function setPlanningLock(
  workspace: string,
  planFile: string,
  status: "in_review" | "denied" | "approved",
  feedback?: string
): void {
  try {
    const lockPath = getPlanningLockPath(workspace);
    const lock: PlanningLock = {
      workspace,
      planFile,
      status,
      feedback,
      updatedAt: Date.now(),
    };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf8");
  } catch {
    // Best-effort lock write
  }
}

export function clearPlanningLock(workspace: string): void {
  try {
    const lockPath = getPlanningLockPath(workspace);
    if (existsSync(lockPath)) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}

export function getAntigravityPlanTarget(event: unknown): string | null {
  if (!isRecord(event) || !isRecord(event.toolCall)) return null;
  if (!isAntigravityCliEvent(event)) return null;
  const { name, args } = event.toolCall;
  if (name === "submit_plan" && isRecord(args) && typeof args.title === "string") {
    return args.title;
  }
  if (isRecord(args) && typeof args.TargetFile === "string") {
    return args.TargetFile;
  }
  return null;
}

export function getAntigravityPlanningLockDenial(event: unknown): string | null {
  if (!isRecord(event) || !isRecord(event.toolCall)) return null;
  if (!isAntigravityCliEvent(event)) return null;
  const { name, args } = event.toolCall;
  if (typeof name !== "string") return null;

  // submit_plan and non-file tools do not trigger file lock denial
  if (name === "submit_plan") return null;
  if (!PLAN_FILE_TOOLS.has(name)) return null;

  if (!isRecord(args) || typeof args.TargetFile !== "string") return null;
  const target = args.TargetFile;

  const artifactDir = typeof event.artifactDirectoryPath === "string" ? event.artifactDirectoryPath : undefined;
  const metadata = isRecord(args.ArtifactMetadata) ? args.ArtifactMetadata : undefined;

  // If modifying a plan file, that is permitted (to be reviewed by Plannotator)
  if (isPlanTarget(target, artifactDir, metadata)) return null;

  // If modifying a source/code file, verify planning lock status
  const rawCwd =
    (Array.isArray(event.workspacePaths) && typeof event.workspacePaths[0] === "string" && event.workspacePaths[0]) ||
    process.env.PLANNOTATOR_CWD ||
    process.cwd();
  const workspaceRoot = rawCwd.split(/[/\\]\.agents/)[0] || rawCwd;
  const lock = getPlanningLock(workspaceRoot);

  if (lock && (lock.status === "in_review" || lock.status === "denied")) {
    const planBase = path.basename(lock.planFile);
    const targetBase = path.basename(target);
    const lines = [
      `Deterministic Planning Lock: Cannot modify code or source file '${targetBase}' because plan '${planBase}' is not yet approved.`,
      `You must address the reviewer's feedback in '${planBase}' and resubmit the complete plan for approval before making code changes.`,
    ];
    if (lock.feedback) {
      lines.push(`\nReviewer feedback to address:\n${lock.feedback}`);
    }
    return lines.join(" ");
  }

  return null;
}

/**
 * Antigravity plan adapter.
 * Reviews proposed plan writes before the tool executes.
 * Supports:
 * - write_to_file on artifact plan files (implementation_plan.md or RequestFeedback artifacts)
 * - write_to_file on workspace plan files (.agents/plans/*.md)
 * - direct submit_plan MCP tool calls
 * Returns string plan content, or null to abstain (unrelated tools retain normal permissions).
 */
export function getAntigravityPlan(event: unknown): string | null {
  if (!isRecord(event) || !isRecord(event.toolCall)) {
    throw new Error("Invalid Antigravity toolCall payload.");
  }
  if (!isAntigravityCliEvent(event)) return null;
  const { name, args } = event.toolCall;
  if (typeof name !== "string") return null;

  // Direct submit_plan MCP tool call
  if (name === "submit_plan") {
    if (!isRecord(args) || typeof args.plan !== "string" || !args.plan.trim()) {
      throw new Error("submit_plan tool requires non-empty plan parameter.");
    }
    return args.plan;
  }

  if (!PLAN_FILE_TOOLS.has(name)) return null;
  if (!isRecord(args) || typeof args.TargetFile !== "string") {
    throw new Error("Antigravity file tool is missing TargetFile.");
  }

  const target = args.TargetFile;
  if (!path.isAbsolute(target)) {
    throw new Error("Antigravity file tool requires absolute TargetFile.");
  }
  if (typeof event.artifactDirectoryPath === "string" && !path.isAbsolute(event.artifactDirectoryPath)) {
    throw new Error("Antigravity plan review requires absolute artifactDirectoryPath.");
  }

  const artifactDir = typeof event.artifactDirectoryPath === "string" ? event.artifactDirectoryPath : undefined;
  const metadata = isRecord(args.ArtifactMetadata) ? args.ArtifactMetadata : undefined;

  if (!isPlanTarget(target, artifactDir, metadata)) {
    return null; // Abstain: not a plan file
  }

  // Require full file payload to review the complete revised plan
  if (name !== "write_to_file") {
    throw new Error(
      "Resubmit the complete revised implementation plan with write_to_file (TargetFile unchanged, Overwrite: true, CodeContent: full plan) so Plannotator can review the exact content before it is written."
    );
  }

  if (typeof args.CodeContent !== "string" || !args.CodeContent.trim()) {
    throw new Error("Antigravity plan write requires non-empty CodeContent.");
  }

  return args.CodeContent;
}

export function formatAntigravityDecision(result: {
  approved: boolean;
  feedback?: string;
  permissionMode?: string;
  reasoningEffort?: string;
}) {
  if (result.approved) {
    const overrides =
      result.permissionMode === "bypassPermissions"
        ? ["*"]
        : result.permissionMode === "acceptEdits"
        ? ["write_to_file", "replace_file_content", "multi_replace_file_content"]
        : undefined;

    const reasons: string[] = [];
    if (result.reasoningEffort) {
      reasons.push(`Reasoning effort: ${result.reasoningEffort}.`);
    }
    if (result.feedback) {
      reasons.push(result.feedback);
    }

    return {
      decision: "allow",
      ...(overrides ? { permissionOverrides: overrides } : {}),
      ...(reasons.length > 0 ? { reason: reasons.join(" ") } : {}),
    };
  }
  return {
    decision: "deny",
    reason: getPlanDeniedPrompt("antigravity", undefined, {
      toolName: "write_to_file",
      planFileRule:
        "- The rejected write did not run. Resubmit the complete revised plan using the same TargetFile, Overwrite: true, and CodeContent containing the full plan.\n" +
        "- STRICT PLANNING LOCK: You are strictly in planning phase. DO NOT begin implementation or edit any code/source files. Address all feedback within this plan document and resubmit it.\n",
      feedback: result.feedback || "Plan changes requested",
    }),
  };
}
