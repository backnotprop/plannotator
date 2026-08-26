export type EslintCheckStatus = "ok" | "unavailable" | "error";

export interface EslintCheckAdvert {
  available: boolean;
  fileCount?: number;
  projectCount?: number;
  reason?: string;
}

export interface EslintDiagnostic {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: 1 | 2;
  ruleId: string | null;
  message: string;
  fixable: boolean;
  onChangedLine: boolean;
}

export interface EslintCheckSummary {
  files: number;
  errors: number;
  warnings: number;
  changedLineErrors: number;
  changedLineWarnings: number;
}

export interface EslintCheckOkResponse {
  status: "ok";
  summary: EslintCheckSummary;
  diagnostics: EslintDiagnostic[];
  eslintVersions: string[];
}

export interface EslintCheckUnavailableResponse {
  status: "unavailable";
  reason: string;
  message: string;
}

export interface EslintCheckErrorResponse {
  status: "error";
  reason: string;
  message: string;
  exitCode?: number;
  stderr?: string;
}

export type EslintCheckResponse =
  | EslintCheckOkResponse
  | EslintCheckUnavailableResponse
  | EslintCheckErrorResponse;
