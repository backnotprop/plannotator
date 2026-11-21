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
  origin?: 'second-opinion';
  band?: 'very-likely' | 'likely';
  model?: string;
  candidateId?: string;
}

export interface SemanticDiffBinaryChange {
  changeType: "binary";
  filePath: string;
  oldFilePath: string | null;
  fileStatus: string | null;
}

export type SemanticDiffUnreadReason = "generated" | "too-large" | "unreadable" | "timed-out";

export interface SemanticDiffUnreadFile {
  path: string;
  reason: SemanticDiffUnreadReason;
}

export interface SemanticDiffOkResponse {
  status: "ok";
  summary: SemanticDiffSummary;
  changes: SemanticDiffChange[];
  binaryChanges: SemanticDiffBinaryChange[];
  unreadFiles?: SemanticDiffUnreadFile[];
}

export type SemanticDiffResponse = SemanticDiffOkResponse;
