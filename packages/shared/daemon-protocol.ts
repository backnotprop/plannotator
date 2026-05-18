import type { PluginRequest, PluginSessionMode } from "./plugin-protocol";

export const PLANNOTATOR_DAEMON_PROTOCOL = "plannotator-daemon";
export const PLANNOTATOR_DAEMON_PROTOCOL_VERSION = 1;
export const PLANNOTATOR_DAEMON_MIN_CLIENT_VERSION = 1;

export const PLANNOTATOR_DAEMON_FEATURES = [
  "capabilities",
  "status",
  "sessions",
  "session-create",
  "session-result-wait",
  "session-cancel",
  "shutdown",
] as const;

export type DaemonFeature = (typeof PLANNOTATOR_DAEMON_FEATURES)[number];
export type DaemonSessionMode = PluginSessionMode;
export type DaemonSessionStatus =
  | "pending"
  | "active"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export interface DaemonCapabilities {
  protocol: typeof PLANNOTATOR_DAEMON_PROTOCOL;
  protocolVersion: typeof PLANNOTATOR_DAEMON_PROTOCOL_VERSION;
  minClientVersion: typeof PLANNOTATOR_DAEMON_MIN_CLIENT_VERSION;
  features: DaemonFeature[];
  transport: "http";
  multiSession: true;
}

export interface DaemonEndpoint {
  hostname: string;
  port: number;
  baseUrl: string;
  isRemote: boolean;
}

export interface DaemonStatus {
  ok: true;
  protocol: typeof PLANNOTATOR_DAEMON_PROTOCOL;
  protocolVersion: typeof PLANNOTATOR_DAEMON_PROTOCOL_VERSION;
  pid: number;
  endpoint: DaemonEndpoint;
  startedAt: string;
  activeSessionCount: number;
  sessionCount: number;
}

export interface DaemonSessionSummary {
  id: string;
  mode: DaemonSessionMode;
  status: DaemonSessionStatus;
  url: string;
  project: string;
  label: string;
  origin?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  error?: string;
  remoteShare?: DaemonRemoteShareNotice;
}

export interface DaemonRemoteShareNotice {
  url: string;
  verb: string;
  noun: string;
  size: string;
}

export interface DaemonCreateSessionRequest {
  request: PluginRequest;
}

export interface DaemonCreateSessionResponse {
  ok: true;
  session: DaemonSessionSummary;
}

export interface DaemonSessionResultResponse<T = unknown> {
  ok: true;
  session: DaemonSessionSummary;
  result: T;
}

export interface DaemonCancelSessionResponse {
  ok: true;
  session: DaemonSessionSummary;
}

export interface DaemonShutdownResponse {
  ok: true;
  shuttingDown: true;
}

export type DaemonErrorCode =
  | "daemon-unreachable"
  | "daemon-stale"
  | "daemon-unhealthy"
  | "daemon-incompatible"
  | "daemon-locked"
  | "session-not-found"
  | "session-cancelled"
  | "session-expired"
  | "invalid-request"
  | "internal-error";

export interface DaemonErrorResponse {
  ok: false;
  protocol: typeof PLANNOTATOR_DAEMON_PROTOCOL;
  protocolVersion: typeof PLANNOTATOR_DAEMON_PROTOCOL_VERSION;
  error: {
    code: DaemonErrorCode;
    message: string;
  };
}

export type DaemonResponse<T> = T | DaemonErrorResponse;

export function getDaemonCapabilities(): DaemonCapabilities {
  return {
    protocol: PLANNOTATOR_DAEMON_PROTOCOL,
    protocolVersion: PLANNOTATOR_DAEMON_PROTOCOL_VERSION,
    minClientVersion: PLANNOTATOR_DAEMON_MIN_CLIENT_VERSION,
    features: [...PLANNOTATOR_DAEMON_FEATURES],
    transport: "http",
    multiSession: true,
  };
}

export function createDaemonErrorResponse(
  code: DaemonErrorCode,
  message: string,
): DaemonErrorResponse {
  return {
    ok: false,
    protocol: PLANNOTATOR_DAEMON_PROTOCOL,
    protocolVersion: PLANNOTATOR_DAEMON_PROTOCOL_VERSION,
    error: { code, message },
  };
}

export function isCompatibleDaemonCapabilities(
  value: unknown,
): value is DaemonCapabilities {
  const caps = value as Partial<DaemonCapabilities> | null;
  return (
    !!caps &&
    caps.protocol === PLANNOTATOR_DAEMON_PROTOCOL &&
    caps.protocolVersion === PLANNOTATOR_DAEMON_PROTOCOL_VERSION &&
    typeof caps.minClientVersion === "number" &&
    caps.minClientVersion <= PLANNOTATOR_DAEMON_PROTOCOL_VERSION &&
    caps.transport === "http" &&
    caps.multiSession === true
  );
}
