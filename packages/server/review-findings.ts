import { classifyFindingPlacement } from "@plannotator/shared/external-annotation";
import { toRelativePath } from "./path-utils";

/** Shared review-finding model and transform for Claude and the marker engines. Codex maps separately (different shape). */

export type ReviewSeverity = "important" | "nit" | "pre_existing";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string | null; // null for a general (review-level) comment
  line?: number | null; // null for a whole-file or general comment
  end_line?: number | null;
  description: string;
  reasoning: string;
}

export interface ReviewAnnotationInput {
  source: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  type: string;
  side: string;
  scope: string;
  text: string;
  severity: ReviewSeverity;
  reasoning: string;
  author: string;
}

export function transformSeverityFindings(
  findings: ReviewFinding[],
  source: string,
  author: string,
  cwd?: string,
  pathTransform?: (path: string) => string,
): ReviewAnnotationInput[] {
  return findings.map((f) => {
    const rawFile = typeof f.file === "string" ? f.file : "";
    const filePath = rawFile
      ? (pathTransform ? pathTransform(toRelativePath(rawFile, cwd)) : toRelativePath(rawFile, cwd))
      : "";
    const placement = classifyFindingPlacement(filePath, f.line, f.end_line);
    return {
      source,
      filePath: placement.filePath,
      lineStart: placement.lineStart,
      lineEnd: placement.lineEnd,
      type: "comment",
      side: "new",
      scope: placement.scope,
      text: `[${f.severity}] ${f.description}`,
      severity: f.severity,
      reasoning: f.reasoning,
      author,
    };
  });
}
