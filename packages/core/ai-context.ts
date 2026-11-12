export type AIContextMode = "plan-review" | "code-review" | "annotate";

export interface ParentSession {
  sessionId: string;
  cwd: string;
}

export interface PlanContext {
  plan: string;
  previousPlan?: string;
  version?: number;
  totalVersions?: number;
  project?: string;
  annotations?: string;
}

export interface CodeReviewContext {
  patch: string;
  diffType?: string;
  base?: string;
  filePath?: string;
  lineRange?: { start: number; end: number; side: "old" | "new" };
  selectedCode?: string;
  annotations?: string;
}

export interface AnnotateContext {
  content: string;
  filePath: string;
  sourceInfo?: string;
  sourceConverted?: boolean;
  renderAs?: "markdown" | "html" | "asciidoc" | "mermaid" | "graphviz" | "code";
  annotations?: string;
  bundlePosition?: { index: number; total: number };
}

export type AIContext =
  | { mode: "plan-review"; plan: PlanContext; parent?: ParentSession }
  | { mode: "code-review"; review: CodeReviewContext; parent?: ParentSession }
  | { mode: "annotate"; annotate: AnnotateContext; parent?: ParentSession };
