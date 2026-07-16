/** The surface the user is interacting with when they invoke AI. */
export type AIContextMode = "plan-review" | "code-review" | "annotate";

/**
 * Describes the parent agent session that originally produced the plan or diff.
 * Used to fork conversations with full history.
 */
export interface ParentSession {
  /** Session ID from the host agent (e.g. Claude Code session UUID). */
  sessionId: string;
  /** Working directory the parent session was running in. */
  cwd: string;
}

/**
 * Snapshot of plan-review-specific context.
 * Passed when AIContextMode is "plan-review".
 */
export interface PlanContext {
  /** The full plan markdown as submitted by the agent. */
  plan: string;
  /** Previous plan version (if this is a resubmission). */
  previousPlan?: string;
  /** The version number in the plan's history. */
  version?: number;
  /** Total number of versions in the plan's history. */
  totalVersions?: number;
  /** Project/repository label used for plan history. */
  project?: string;
  /** Annotations the user has made so far (serialised for the prompt). */
  annotations?: string;
}

/**
 * Snapshot of code-review-specific context.
 * Passed when AIContextMode is "code-review".
 */
export interface CodeReviewContext {
  /** The unified diff patch. Used as a fallback when the changeset can't be
   *  reproduced locally with a single VCS command. */
  patch: string;
  /** The VCS diff type (e.g. "uncommitted", "branch", "merge-base"). When set
   *  to a git-reproducible type, the prompt tells the agent how to inspect the
   *  changes with git instead of pasting the whole diff. */
  diffType?: string;
  /** The base branch/ref the diff is computed against (for branch/merge-base). */
  base?: string;
  /** The specific file being discussed (if scoped). */
  filePath?: string;
  /** The line range being discussed (if scoped). */
  lineRange?: { start: number; end: number; side: "old" | "new" };
  /** The code snippet being discussed (if scoped). */
  selectedCode?: string;
  /** Summary of annotations the user has made. */
  annotations?: string;
}

/**
 * Snapshot of annotate-mode context.
 * Passed when AIContextMode is "annotate".
 */
export interface AnnotateContext {
  /** The markdown file content being annotated. */
  content: string;
  /** Path to the file on disk. */
  filePath: string;
  /** Source attribution shown in the UI, such as an original URL or filename. */
  sourceInfo?: string;
  /** True when the document was converted from HTML or a remote reader result. */
  sourceConverted?: boolean;
  /** Render mode for the annotated content. */
  renderAs?: "markdown" | "html";
  /** Summary of annotations the user has made. */
  annotations?: string;
}

/**
 * Union of mode-specific contexts, discriminated by `mode`.
 */
export type AIContext =
  | { mode: "plan-review"; plan: PlanContext; parent?: ParentSession }
  | { mode: "code-review"; review: CodeReviewContext; parent?: ParentSession }
  | { mode: "annotate"; annotate: AnnotateContext; parent?: ParentSession };
