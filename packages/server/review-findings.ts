import { classifyFindingPlacement } from "@plannotator/shared/external-annotation";
import { toRelativePath } from "./path-utils";

/**
 * Shared review-finding model + transform.
 *
 * Claude and the marker engines (Cursor/OpenCode) all emit findings with the
 * same shape — `{ severity, file?, line?, end_line?, description, reasoning }`,
 * nullable file/line — and turn them into annotations the same way (relative
 * path → classifyFindingPlacement → line/whole-file/general). This is the one
 * canonical place for that, so a placement/annotation fix lands once.
 *
 * (Codex is NOT here: its findings carry a different shape — priority +
 * code_location — and it maps separately.)
 */

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

/**
 * Transform severity-style findings into annotation inputs. Routes each finding
 * by what it carries — nothing is dropped: file+line → line comment; file only
 * → whole-file comment; neither → general (review-level) comment.
 */
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
