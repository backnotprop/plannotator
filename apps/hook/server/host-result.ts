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
}

let takenPath: string | undefined;
let taken = false;

/**
 * The only place a result record may be written: a `result.json` inside the
 * mod's launch area of the data dir (`<data dir>/claude-code-mod/…`). Anything
 * else is refused, so the variable can never be used to make the CLI create
 * or replace an arbitrary file.
 */
export function isAllowedHostResultPath(path: string, dataDir: string = getPlannotatorDataDir()): boolean {
  if (!isAbsolute(path) || basename(path) !== "result.json") return false;
  const root = resolve(dataDir, "claude-code-mod") + sep;
  return resolve(path).startsWith(root);
}

/** Read the side-channel path once and scrub it from the environment. */
export function takeHostResultPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!taken) {
    taken = true;
    const value = env[HOST_RESULT_FILE_ENV];
    delete env[HOST_RESULT_FILE_ENV];
    const path = value && value.trim() ? value : undefined;
    if (path && !isAllowedHostResultPath(path)) {
      console.error(`Plannotator: ignoring ${HOST_RESULT_FILE_ENV}: not a result.json under the data dir's claude-code-mod/ folder.`);
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
}

/**
 * Review: `output` is what the CLI prints (buildReviewOutput), so the message
 * is byte-identical to the plaintext a skill-run review hands the agent.
 */
export function reviewHostResult(result: ReviewOutcomeLike, output: ReviewOutput): HostResultRecord {
  const annotationCount = result.annotations.length;
  const hasFeedback = !!result.feedback && result.feedback.trim() !== "";
  if (output.decision === "dismissed") {
    return { v: 1, surface: "review", decision: "dismissed", message: "", noop: true, annotationCount: 0 };
  }
  if (output.decision === "approved") {
    // A bare approval (LGTM) carries nothing the agent must act on.
    const noop = !hasFeedback;
    return { v: 1, surface: "review", decision: "approved", message: noop ? "" : output.message, noop, annotationCount };
  }
  // Annotated with zero annotations: the platform path's status post (the
  // review went to GitHub/GitLab/Bitbucket) or an empty submit.
  if (annotationCount === 0) {
    return { v: 1, surface: "review", decision: "annotated", message: output.message, noop: true, annotationCount, platform: hasFeedback };
  }
  return { v: 1, surface: "review", decision: "annotated", message: output.message, noop: false, annotationCount };
}

interface AnnotateOutcomeLike {
  approved?: boolean;
  feedback?: string;
  exit?: boolean;
  annotations?: readonly unknown[];
}

export interface AnnotateHostContext {
  /** "last-message" for annotate-last. */
  kind: "file" | "folder" | "url" | "last";
  /** Absolute file/folder path or URL; unused for `last`. */
  target?: string;
  origin?: Origin;
  config?: PlannotatorConfig;
}

/**
 * Annotate and annotate-last. The CLI prints raw feedback for these (the skill
 * text frames it); a detached host has no skill, so the record carries the
 * framing the OpenCode and Pi hosts use.
 */
export function annotateHostResult(result: AnnotateOutcomeLike, context: AnnotateHostContext): HostResultRecord {
  const surface: HostResultSurface = context.kind === "last" ? "annotate-last" : "annotate";
  const annotationCount = Array.isArray(result.annotations) ? result.annotations.length : undefined;
  const feedback = (result.feedback ?? "").trim() ? result.feedback ?? "" : "";
  const runtime = context.origin ?? "claude-code";
  if (result.exit) {
    return { v: 1, surface, decision: "dismissed", message: "", noop: true, ...(annotationCount !== undefined && { annotationCount }) };
  }
  const header = context.kind === "folder" ? "Folder" : context.kind === "url" ? "URL" : "File";
  if (result.approved) {
    if (!feedback) {
      return { v: 1, surface, decision: "approved", message: getAnnotateApprovedPrompt(runtime, context.config), noop: true, ...(annotationCount !== undefined && { annotationCount }) };
    }
    const contextLine = context.kind === "last" ? "" : `${header}: ${context.target ?? ""}`;
    return {
      v: 1,
      surface,
      decision: "approved",
      message: getAnnotateApprovedWithNotesPrompt(runtime, context.config, { context: contextLine, feedback }),
      noop: false,
      ...(annotationCount !== undefined && { annotationCount }),
    };
  }
  if (!feedback) {
    // Done with nothing to send.
    return { v: 1, surface, decision: "annotated", message: "", noop: true, annotationCount: annotationCount ?? 0 };
  }
  const message = context.kind === "last"
    ? getAnnotateMessageFeedbackPrompt(runtime, context.config, { feedback })
    : getAnnotateFileFeedbackPrompt(runtime, context.config, { fileHeader: header, filePath: context.target ?? "", feedback });
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
