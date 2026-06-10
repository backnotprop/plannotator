export type SemanticDiffStatus = "ok" | "unavailable" | "error";

export interface SemanticDiffSummary {
  fileCount: number;
  added: number;
  modified: number;
  deleted: number;
  moved: number;
  renamed: number;
  reordered: number;
  binary: number;
  orphan: number;
  total: number;
}

export interface SemanticDiffChange {
  entityId: string | null;
  changeType: string;
  entityType: string;
  entityName: string;
  oldEntityName: string | null;
  filePath: string;
  oldFilePath: string | null;
  startLine: number | null;
  endLine: number | null;
  oldStartLine: number | null;
  oldEndLine: number | null;
  structuralChange: boolean | null;
}

export interface SemanticDiffBinaryChange {
  changeType: "binary";
  filePath: string;
  oldFilePath: string | null;
  fileStatus: string | null;
}

export interface SemanticDiffOkResponse {
  status: "ok";
  summary: SemanticDiffSummary;
  changes: SemanticDiffChange[];
  binaryChanges: SemanticDiffBinaryChange[];
  semVersion: string;
  semSource: string;
}

export interface SemanticDiffUnavailableResponse {
  status: "unavailable";
  reason: string;
  message: string;
}

export interface SemanticDiffErrorResponse {
  status: "error";
  reason: string;
  message: string;
  exitCode?: number;
  stderr?: string;
  semVersion?: string;
  semSource?: string;
}

export type SemanticDiffResponse =
  | SemanticDiffOkResponse
  | SemanticDiffUnavailableResponse
  | SemanticDiffErrorResponse;

export interface SemanticDiffAvailability {
  available: boolean;
  reason?: string;
  message?: string;
  semVersion?: string;
  semSource?: string;
}

export type SemanticDiffAdvert = Pick<SemanticDiffAvailability, "available" | "semVersion" | "semSource">;
