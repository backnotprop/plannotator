/** The surface the user is interacting with when they invoke AI. */
export type AIContextMode = "plan-review" | "code-review" | "annotate";

/** Describes the parent agent session that originally produced the plan or diff. */
export interface ParentSession {
  sessionId: string;
  cwd: string;
}

/** Snapshot of plan-review-specific context. */
export interface PlanContext {
  plan: string;
  previousPlan?: string;
  version?: number;
  totalVersions?: number;
  project?: string;
  annotations?: string;
}

/** Snapshot of code-review-specific context. */
export interface CodeReviewContext {
  /** The unified diff patch. Used as a fallback when the changeset can't be
   *  reproduced locally with a single VCS command. */
  patch: string;
  diffType?: string;
  base?: string;
  filePath?: string;
  lineRange?: { start: number; end: number; side: "old" | "new" };
  selectedCode?: string;
  annotations?: string;
}

/** Snapshot of annotate-mode context. */
export interface AnnotateContext {
  content: string;
  filePath: string;
  sourceInfo?: string;
  sourceConverted?: boolean;
  renderAs?: "markdown" | "html" | "asciidoc" | "mermaid" | "graphviz" | "code";
  annotations?: string;
  bundlePosition?: { index: number; total: number };
}

/** Union of mode-specific contexts, discriminated by `mode`. */
export type AIContext =
  | { mode: "plan-review"; plan: PlanContext; parent?: ParentSession }
  | { mode: "code-review"; review: CodeReviewContext; parent?: ParentSession }
  | { mode: "annotate"; annotate: AnnotateContext; parent?: ParentSession };
