import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import type { Origin } from "@plannotator/shared/agents";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import {
  composePlanDeniedMessage,
  getAnnotateApprovedPrompt,
  getAnnotateApprovedWithNotesPrompt,
  getAnnotateFileFeedbackPrompt,
  getAnnotateMessageFeedbackPrompt,
  getPlanApprovedPrompt,
  getPlanApprovedWithNotesPrompt,
  getPlanToolName,
} from "@plannotator/shared/prompts";
import type { ReviewOutput } from "./review-output";
import { annotateBundleDocumentCounts, annotateBundleTargetText } from "@plannotator/shared/annotate-bundle";

export const HOST_RESULT_FILE_ENV = "PLANNOTATOR_HOST_RESULT_FILE";

export type HostResultSurface = "plan" | "review" | "annotate" | "annotate-last";

export type HostResultDecision = "approved" | "annotated" | "dismissed" | "denied" | "answered";

export interface HostResultRecord {
  v: 1;
  surface: HostResultSurface;
  decision: HostResultDecision;
  message: string;
  noop: boolean;
  annotationCount?: number;
  platform?: boolean;
  withNotes?: boolean;
  approvedPlan?: string;
  permissionMode?: string;
  closedBy?: "agent";
  unsentAnnotations?: number;
  documents?: { path: string; annotationCount: number }[];
  target?: string | string[];
}

function closedByFields(result: { closedBy?: unknown; unsentAnnotations?: unknown }): Pick<HostResultRecord, "closedBy" | "unsentAnnotations"> {
  if (result.closedBy !== "agent") return {};
  return {
    closedBy: "agent",
    ...(typeof result.unsentAnnotations === "number" ? { unsentAnnotations: result.unsentAnnotations } : {}),
  };
}

let takenPath: string | undefined;
let taken = false;

export function isAllowedHostResultPath(path: string, dataDir: string = getPlannotatorDataDir()): boolean {
  if (!isAbsolute(path) || basename(path) !== "result.json") return false;
  return ["claude-code-mod", "t3-code", "dsh"].some((host) => resolve(path).startsWith(resolve(dataDir, host) + sep));
}

export function takeHostResultPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!taken) {
    taken = true;
    const value = env[HOST_RESULT_FILE_ENV];
    delete env[HOST_RESULT_FILE_ENV];
    const path = value && value.trim() ? value : undefined;
    if (path && !isAllowedHostResultPath(path)) {
      console.error(`Plannotator: ignoring ${HOST_RESULT_FILE_ENV}: not a result.json under the data dir's host launch folders.`);
      takenPath = undefined;
    } else {
      takenPath = path;
    }
  }
  return takenPath;
}

export function writeHostResult(path: string, record: HostResultRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    console.error(`Plannotator: could not write the host result file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function publishHostResult(record: HostResultRecord): void {
  const path = takeHostResultPath();
  if (path) writeHostResult(path, record);
}

interface ReviewOutcomeLike {
  approved: boolean;
  feedback: string;
  annotations: readonly unknown[];
  exit?: boolean;
  closedBy?: "agent";
  unsentAnnotations?: number;
  platform?: boolean;
}

export function reviewHostResult(result: ReviewOutcomeLike, output: ReviewOutput, context: { target?: string } = {}): HostResultRecord {
  return withTarget(reviewHostRecord(result, output), context.target);
}

function withTarget(record: HostResultRecord, target: string | readonly string[] | undefined): HostResultRecord {
  if (target === undefined) return record;
  if (typeof target === "string") return target.trim() ? { ...record, target } : record;
  return target.length > 0 ? { ...record, target: [...target] } : record;
}

function reviewHostRecord(result: ReviewOutcomeLike, output: ReviewOutput): HostResultRecord {
  const annotationCount = result.annotations.length;
  const hasFeedback = !!result.feedback && result.feedback.trim() !== "";
  if (output.decision === "dismissed") {
    return { v: 1, surface: "review", decision: "dismissed", message: "", noop: true, annotationCount: 0, ...closedByFields(result) };
  }
  if (output.decision === "approved") {
    const noop = !hasFeedback;
    return { v: 1, surface: "review", decision: "approved", message: output.message, noop, annotationCount };
  }
  if (result.platform === true) {
    return { v: 1, surface: "review", decision: "annotated", message: output.message, noop: true, annotationCount, platform: true };
  }
  if (!hasFeedback && annotationCount === 0) {
    return { v: 1, surface: "review", decision: "annotated", message: output.message, noop: true, annotationCount };
  }
  return { v: 1, surface: "review", decision: "annotated", message: output.message, noop: false, annotationCount };
}

interface AnnotateOutcomeLike {
  approved?: boolean;
  feedback?: string;
  exit?: boolean;
  annotations?: readonly unknown[];
  nothingToSend?: boolean;
  closedBy?: "agent";
  unsentAnnotations?: number;
}

export interface AnnotateHostContext {
  kind: "file" | "folder" | "url" | "last" | "bundle";
  target?: string;
  bundlePaths?: readonly string[];
  origin?: Origin;
  config?: PlannotatorConfig;
}

function annotateTargetHeader(kind: AnnotateHostContext["kind"]): "File" | "Folder" | "URL" | "Files" {
  return kind === "folder" ? "Folder" : kind === "url" ? "URL" : kind === "bundle" ? "Files" : "File";
}

function annotateTargetText(context: AnnotateHostContext): string {
  return context.kind === "bundle" ? annotateBundleTargetText(context.bundlePaths ?? []) : context.target ?? "";
}

export function annotateContextLine(context: AnnotateHostContext): string {
  if (context.kind === "last") return "";
  return `${annotateTargetHeader(context.kind)}: ${annotateTargetText(context)}`;
}

export function annotateHostResult(result: AnnotateOutcomeLike, context: AnnotateHostContext): HostResultRecord {
  const record = withTarget(
    annotateHostRecord(result, context),
    context.kind === "last" ? undefined : context.kind === "bundle" ? context.bundlePaths : context.target,
  );
  if (context.kind !== "bundle") return record;
  return {
    ...record,
    documents: annotateBundleDocumentCounts(context.bundlePaths ?? [], Array.isArray(result.annotations) ? result.annotations : []),
  };
}

function annotateHostRecord(result: AnnotateOutcomeLike, context: AnnotateHostContext): HostResultRecord {
  const surface: HostResultSurface = context.kind === "last" ? "annotate-last" : "annotate";
  const annotationCount = Array.isArray(result.annotations) ? result.annotations.length : undefined;
  const feedback = (result.feedback ?? "").trim() ? result.feedback ?? "" : "";
  const runtime = context.origin ?? "claude-code";
  if (result.exit) {
    return { v: 1, surface, decision: "dismissed", message: "", noop: true, ...(annotationCount !== undefined && { annotationCount }), ...closedByFields(result) };
  }
  const header = annotateTargetHeader(context.kind);
  if (result.approved) {
    if (!feedback) {
      return { v: 1, surface, decision: "approved", message: getAnnotateApprovedPrompt(runtime, context.config), noop: true, ...(annotationCount !== undefined && { annotationCount }) };
    }
    const contextLine = annotateContextLine(context);
    return {
      v: 1,
      surface,
      decision: "approved",
      message: getAnnotateApprovedWithNotesPrompt(runtime, context.config, { context: contextLine, feedback }),
      noop: false,
      ...(annotationCount !== undefined && { annotationCount }),
    };
  }
  if (!feedback || result.nothingToSend === true) {
    return { v: 1, surface, decision: "annotated", message: "", noop: true, annotationCount: annotationCount ?? 0 };
  }
  const message = context.kind === "last"
    ? getAnnotateMessageFeedbackPrompt(runtime, context.config, { feedback })
    : getAnnotateFileFeedbackPrompt(runtime, context.config, { fileHeader: header, filePath: annotateTargetText(context), feedback });
  return { v: 1, surface, decision: "annotated", message, noop: false, ...(annotationCount !== undefined && { annotationCount }) };
}

interface PlanDecisionLike {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  permissionMode?: string;
  answersOnly?: boolean;
}

export function planHostResult(
  result: PlanDecisionLike,
  context: { approvedPlan: string; planFilePath?: string; config?: PlannotatorConfig },
): HostResultRecord {
  return withTarget(planHostRecord(result, context), context.planFilePath);
}

function planHostRecord(
  result: PlanDecisionLike,
  context: { approvedPlan: string; planFilePath?: string; config?: PlannotatorConfig },
): HostResultRecord {
  const runtime = "claude-code" as const;
  if (result.approved) {
    const vars = {
      planFilePath: context.planFilePath ?? "the approved plan",
      doneMsg: result.savedPath ? `Saved to: ${result.savedPath}` : "",
      feedback: result.feedback ?? "",
    };
    const withNotes = !!result.feedback && result.feedback.trim() !== "";
    const message = withNotes
      ? getPlanApprovedWithNotesPrompt(runtime, context.config, vars)
      : getPlanApprovedPrompt(runtime, context.config, vars);
    return {
      v: 1,
      surface: "plan",
      decision: "approved",
      message: message.trim(),
      noop: false,
      ...(withNotes && { withNotes: true }),
      approvedPlan: context.approvedPlan,
      ...(result.permissionMode && { permissionMode: result.permissionMode }),
    };
  }
  const answersOnly = result.answersOnly === true;
  return {
    v: 1,
    surface: "plan",
    decision: answersOnly ? "answered" : "denied",
    message: composePlanDeniedMessage(runtime, context.config, {
      toolName: getPlanToolName(runtime),
      planFileRule: "",
      feedback: result.feedback || "Plan changes requested",
    }, { answersOnly }),
    noop: false,
  };
}
