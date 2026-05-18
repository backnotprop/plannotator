import type { Origin } from "./agents";

export const PLANNOTATOR_PLUGIN_PROTOCOL = "plannotator-plugin";
export const PLANNOTATOR_PLUGIN_PROTOCOL_VERSION = 1;
export const PLANNOTATOR_PLUGIN_MIN_CLIENT_VERSION = 1;

export const PLANNOTATOR_PLUGIN_FEATURES = [
  "capabilities",
  "plan-review",
  "code-review",
  "annotate",
  "annotate-last",
  "archive",
] as const;

export type PluginFeature = (typeof PLANNOTATOR_PLUGIN_FEATURES)[number];
export type PluginClientOrigin = Extract<Origin, "opencode" | "pi">;
export type PluginSessionMode = "plan" | "review" | "annotate" | "archive";

export interface PluginCapabilities {
  protocol: typeof PLANNOTATOR_PLUGIN_PROTOCOL;
  protocolVersion: typeof PLANNOTATOR_PLUGIN_PROTOCOL_VERSION;
  minClientVersion: typeof PLANNOTATOR_PLUGIN_MIN_CLIENT_VERSION;
  features: PluginFeature[];
  daemonReady: true;
  multiSessionDaemon?: boolean;
}

export interface PluginBaseRequest {
  origin: PluginClientOrigin;
  cwd?: string;
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
}

export interface PluginAgentInfo {
  name: string;
  description?: string;
  mode: string;
  hidden?: boolean;
}

export interface PluginPlanRequest extends PluginBaseRequest {
  plan?: string;
  planFilePath?: string;
  permissionMode?: string;
  availableAgents?: PluginAgentInfo[];
}

export interface PluginReviewRequest extends PluginBaseRequest {
  args?: string;
  prUrl?: string;
  vcsType?: "auto" | "git" | "jj" | "p4";
  useLocal?: boolean;
  diffType?: string;
  defaultBranch?: string;
  availableAgents?: PluginAgentInfo[];
}

export interface PluginAnnotateRequest extends PluginBaseRequest {
  args?: string;
  markdown?: string;
  filePath?: string;
  mode?: "annotate" | "annotate-folder" | "annotate-last";
  folderPath?: string;
  sourceInfo?: string;
  sourceConverted?: boolean;
  gate?: boolean;
  rawHtml?: string;
  renderHtml?: boolean;
}

export interface PluginArchiveRequest extends PluginBaseRequest {
  customPlanPath?: string | null;
}

export type PluginRequest =
  | ({ action: "plan" } & PluginPlanRequest)
  | ({ action: "review" } & PluginReviewRequest)
  | ({ action: "annotate" } & PluginAnnotateRequest)
  | ({ action: "annotate-last" } & PluginAnnotateRequest)
  | ({ action: "archive" } & PluginArchiveRequest);

export interface PluginSessionInfo {
  mode: PluginSessionMode;
  url: string;
  port: number;
  isRemote: boolean;
}

export interface PluginPlanResult {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
}

export interface PluginReviewResult {
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
  agentSwitch?: string;
  exit?: boolean;
}

export interface PluginAnnotateResult {
  feedback: string;
  annotations?: unknown[];
  exit?: boolean;
  approved?: boolean;
  filePath?: string;
  mode?: "annotate" | "annotate-folder" | "annotate-last";
}

export interface PluginArchiveResult {
  opened: boolean;
}

export type PluginActionResult =
  | PluginPlanResult
  | PluginReviewResult
  | PluginAnnotateResult
  | PluginArchiveResult;

export type PluginSuccessResponse<T extends PluginActionResult = PluginActionResult> = {
  ok: true;
  protocol: typeof PLANNOTATOR_PLUGIN_PROTOCOL;
  protocolVersion: typeof PLANNOTATOR_PLUGIN_PROTOCOL_VERSION;
  session?: PluginSessionInfo;
  result: T;
};

export type PluginErrorResponse = {
  ok: false;
  protocol: typeof PLANNOTATOR_PLUGIN_PROTOCOL;
  protocolVersion: typeof PLANNOTATOR_PLUGIN_PROTOCOL_VERSION;
  error: {
    code: string;
    message: string;
  };
};

export type PluginResponse<T extends PluginActionResult = PluginActionResult> =
  | PluginSuccessResponse<T>
  | PluginErrorResponse;

export function getPluginCapabilities(): PluginCapabilities {
  return {
    protocol: PLANNOTATOR_PLUGIN_PROTOCOL,
    protocolVersion: PLANNOTATOR_PLUGIN_PROTOCOL_VERSION,
    minClientVersion: PLANNOTATOR_PLUGIN_MIN_CLIENT_VERSION,
    features: [...PLANNOTATOR_PLUGIN_FEATURES],
    daemonReady: true,
    multiSessionDaemon: false,
  };
}

export function createPluginSuccessResponse<T extends PluginActionResult>(
  result: T,
  session?: PluginSessionInfo,
): PluginSuccessResponse<T> {
  return {
    ok: true,
    protocol: PLANNOTATOR_PLUGIN_PROTOCOL,
    protocolVersion: PLANNOTATOR_PLUGIN_PROTOCOL_VERSION,
    ...(session && { session }),
    result,
  };
}

export function createPluginErrorResponse(code: string, message: string): PluginErrorResponse {
  return {
    ok: false,
    protocol: PLANNOTATOR_PLUGIN_PROTOCOL,
    protocolVersion: PLANNOTATOR_PLUGIN_PROTOCOL_VERSION,
    error: { code, message },
  };
}

export function parsePluginResponse<T extends PluginActionResult = PluginActionResult>(
  raw: string,
): PluginResponse<T> | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PluginResponse<T>>;
    if (parsed.protocol !== PLANNOTATOR_PLUGIN_PROTOCOL) return null;
    if (typeof parsed.protocolVersion !== "number") return null;
    if (parsed.protocolVersion < PLANNOTATOR_PLUGIN_PROTOCOL_VERSION) return null;

    if (parsed.ok === true) {
      if (!("result" in parsed)) return null;
      return parsed as PluginSuccessResponse<T>;
    }

    if (parsed.ok === false) {
      const error = (parsed as PluginErrorResponse).error;
      if (!error || typeof error.code !== "string" || typeof error.message !== "string") {
        return null;
      }
      return parsed as PluginErrorResponse;
    }

    return null;
  } catch {
    return null;
  }
}
