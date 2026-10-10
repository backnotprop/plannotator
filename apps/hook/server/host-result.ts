/**
 * Host result side channel.
 *
 * A host that starts the CLI as a DETACHED process (the Claude Code mod in
 * `apps/hook/hooks/mod/`) cannot read the decision off stdout while the tool
 * call that started it is long gone. It sets `PLANNOTATOR_HOST_RESULT_FILE`
 * to a path of its own; when the session settles, the CLI writes ONE JSON
 * record there, atomically (temp file + rename), with the agent-facing message
 * already composed from the configured prompts. Stdout is unchanged, so every
 * other caller sees exactly what it always did.
 *
 * The variable is taken once at startup and removed from `process.env`, so
 * nothing the server spawns (agent jobs, terminals) inherits it.
 */

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

/** Version 1 of the record. Fields are only ever added. */
export interface HostResultRecord {
  v: 1;
  surface: HostResultSurface;
  decision: HostResultDecision;
  /** What the agent should read, composed from the configured prompts. Empty when `noop`. */
  message: string;
  /** Nothing for the agent: a bare Done, LGTM, close, or a review posted to a PR platform. */
  noop: boolean;
  /** How many annotations the reviewer submitted (review and annotate). */
  annotationCount?: number;
  /** Review only: the reviewer posted the review to the PR platform instead. */
  platform?: boolean;
  /** Plan only: the approval carried notes (the approved-with-notes prompt). */
  withNotes?: boolean;
  /** Plan only: the exact plan text on screen when the reviewer approved. */
  approvedPlan?: string;
  /** Plan only: the permission mode the reviewer chose for execution. */
  permissionMode?: string;
  /** A `dismissed` the host itself asked for (`POST /api/host/close`), not the reviewer. */
  closedBy?: "agent";
  /** With `closedBy`: the reviewer's unsent comments, kept in the draft. */
  unsentAnnotations?: number;
  /** Annotate of several files (a bundle): each file, in review order, with how many comments were made on it. */
  documents?: { path: string; annotationCount: number }[];
  /**
   * What the decision is about, in full, as THIS server resolved it: the
   * absolute file or folder path or the URL (annotate), the files in review
   * order (a bundle), the reviewed directory, patch file or PR URL (review),
   * the plan file (plan, when the host gave one). Absent for annotate-last.
   * A host names it in the message it delivers, so two files that share a
   * name can never be confused.
   */
  target?: string | string[];
}

/** The `closedBy` / `unsentAnnotations` pair a host close adds to a dismissal. */
function closedByFields(result: { closedBy?: unknown; unsentAnnotations?: unknown }): Pick<HostResultRecord, "closedBy" | "unsentAnnotations"> {
  if (result.closedBy !== "agent") return {};
  return {
    closedBy: "agent",
    ...(typeof result.unsentAnnotations === "number" ? { unsentAnnotations: result.unsentAnnotations } : {}),
  };
}

let takenPath: string | undefined;
let taken = false;

/**
 * The only place a result record may be written: a `result.json` inside the
 * host's launch area of the data dir (`claude-code-mod/` or `t3-code/`). Anything
 * else is refused, so the variable can never be used to make the CLI create
 * or replace an arbitrary file.
 */
export function isAllowedHostResultPath(path: string, dataDir: string = getPlannotatorDataDir()): boolean {
  if (!isAbsolute(path) || basename(path) !== "result.json") return false;
  return ["claude-code-mod", "t3-code"].some((host) => resolve(path).startsWith(resolve(dataDir, host) + sep));
}

/** Read the side-channel path once and scrub it from the environment. */
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

/** Atomically write the record. Best effort: a failure is reported on stderr only. */
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

// --- Record builders (pure) --------------------------------------------------

interface ReviewOutcomeLike {
  approved: boolean;
  feedback: string;
  annotations: readonly unknown[];
  exit?: boolean;
  closedBy?: "agent";
  unsentAnnotations?: number;
  /** Set by the review server only for the platform path's status post. */
  platform?: boolean;
}

/**
 * Review: `output` is what the CLI prints (buildReviewOutput), so the message
 * is byte-identical to the plaintext a skill-run review hands the agent.
 */
export function reviewHostResult(result: ReviewOutcomeLike, output: ReviewOutput, context: { target?: string } = {}): HostResultRecord {
  return withTarget(reviewHostRecord(result, output), context.target);
}

/** `record` with `target` added when there is one. */
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
    // A bare approval (LGTM) carries nothing the agent must act on.
    const noop = !hasFeedback;
    return { v: 1, surface: "review", decision: "approved", message: noop ? "" : output.message, noop, annotationCount };
  }
  // The platform path's status post (the review went to GitHub/GitLab/
  // Bitbucket): the review server marks it `platform: true`. Never inferred
  // from zero annotations: PR description, PR comment and editor comments
  // ride only in `feedback`, so feedback made only of those has an empty
  // annotation list and must still reach the agent.
  if (result.platform === true) {
    return { v: 1, surface: "review", decision: "annotated", message: output.message, noop: true, annotationCount, platform: true };
  }
  // A truly empty submit: nothing to send.
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
  /** The editor's Done with nothing to send: `feedback` still carries the
   *  legacy zero-state sentence (stdout and `--json` keep it), but there is
   *  nothing for the agent. */
  nothingToSend?: boolean;
  closedBy?: "agent";
  unsentAnnotations?: number;
}

export interface AnnotateHostContext {
  /** "last-message" for annotate-last; "bundle" for several files reviewed as one. */
  kind: "file" | "folder" | "url" | "last" | "bundle";
  /** Absolute file/folder path or URL; unused for `last` and `bundle`. */
  target?: string;
  /** `bundle`: the files in review order (absolute). */
  bundlePaths?: readonly string[];
  origin?: Origin;
  config?: PlannotatorConfig;
}

/** The header word for an annotate target (`File`, `Folder`, `URL`, `Files`). */
function annotateTargetHeader(kind: AnnotateHostContext["kind"]): "File" | "Folder" | "URL" | "Files" {
  return kind === "folder" ? "Folder" : kind === "url" ? "URL" : kind === "bundle" ? "Files" : "File";
}

/** The target an annotate session names: the bundle's file list, else `target`. */
function annotateTargetText(context: AnnotateHostContext): string {
  return context.kind === "bundle" ? annotateBundleTargetText(context.bundlePaths ?? []) : context.target ?? "";
}

/**
 * The `{{context}}` of the approved-with-notes prompt: `File: <path>`,
 * `Folder: …`, `URL: …` or `Files: …`; empty for annotate-last. One helper
 * for the result file and the CLI's plaintext stdout, so both name the target
 * the same way.
 */
export function annotateContextLine(context: AnnotateHostContext): string {
  if (context.kind === "last") return "";
  return `${annotateTargetHeader(context.kind)}: ${annotateTargetText(context)}`;
}

/**
 * Annotate and annotate-last. The CLI prints raw feedback for these (the skill
 * text frames it); a detached host has no skill, so the record carries the
 * framing the OpenCode and Pi hosts use.
 */
export function annotateHostResult(result: AnnotateOutcomeLike, context: AnnotateHostContext): HostResultRecord {
  const record = withTarget(
    annotateHostRecord(result, context),
    context.kind === "last" ? undefined : context.kind === "bundle" ? context.bundlePaths : context.target,
  );
  if (context.kind !== "bundle") return record;
  // A bundle names each file with its comment count, in review order.
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
    // Done with nothing to send. The editor still posts the zero-state
    // sentence as feedback (stdout keeps it), and marks the body instead.
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

/** Plan review in a host that does not block on ExitPlanMode (the Claude Code mod). */
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
