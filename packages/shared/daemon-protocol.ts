import type { PluginRequest, PluginSessionMode } from "./plugin-protocol";

export const PLANNOTATOR_DAEMON_PROTOCOL = "plannotator-daemon";
export const PLANNOTATOR_DAEMON_PROTOCOL_VERSION = 2;
export const PLANNOTATOR_DAEMON_MIN_CLIENT_VERSION = 1;

export const PLANNOTATOR_DAEMON_FEATURES = [
  "capabilities",
  "status",
  "sessions",
  "session-create",
  "session-bootstrap",
  "session-result-wait",
  "session-cancel",
  "shutdown",
  "websocket-events",
  "session-events",
  "session-actions",
  "debug-events",
  "project-registry",
] as const;

export const PLANNOTATOR_DAEMON_EVENT_FAMILIES = [
  "daemon",
  "external-annotations",
  "agent-jobs",
  "session-revision",
] as const;

export const PLANNOTATOR_DAEMON_SESSION_VIEWS = [
  "plan",
  "review",
  "annotate",
  "goal-setup",
] as const;

export type DaemonFeature = (typeof PLANNOTATOR_DAEMON_FEATURES)[number];
export type DaemonEventFamily = (typeof PLANNOTATOR_DAEMON_EVENT_FAMILIES)[number];
export type DaemonSessionMode = PluginSessionMode;
export type DaemonSessionView = (typeof PLANNOTATOR_DAEMON_SESSION_VIEWS)[number];
export type DaemonSessionStatus =
  | "active"
  | "idle"
  | "awaiting-resubmission"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export interface DaemonCapabilities {
  protocol: typeof PLANNOTATOR_DAEMON_PROTOCOL;
  protocolVersion: number;
  minClientVersion: number;
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
  protocolVersion: number;
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
  cwd?: string;
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

export interface DaemonSessionBootstrapResponse {
  ok: true;
  session: DaemonSessionSummary;
  apiBase: string;
  capabilities: DaemonCapabilities;
  supportedSessionViews: DaemonSessionView[];
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

export interface DaemonProjectEntry {
  name: string;
  cwd: string;
  lastSeen: string;
  parentCwd?: string;
  branch?: string;
}

export interface DaemonProjectListResponse {
  ok: true;
  projects: DaemonProjectEntry[];
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
  | "unauthorized"
  | "invalid-request"
  | "internal-error";

export interface DaemonErrorResponse {
  ok: false;
  protocol: typeof PLANNOTATOR_DAEMON_PROTOCOL;
  protocolVersion: number;
  error: {
    code: DaemonErrorCode;
    message: string;
  };
}

export type DaemonResponse<T> = T | DaemonErrorResponse;

export type DaemonEventType =
  | "snapshot"
  | "daemon-status"
  | "session-created"
  | "session-updated"
  | "session-removed"
  | "session-notify"
  | "daemon-error"
  | "debug-log";

export type DaemonEvent =
  | {
      type: "snapshot";
      at: string;
      status: DaemonStatus;
      sessions: DaemonSessionSummary[];
    }
  | {
      type: "daemon-status";
      at: string;
      status: DaemonStatus;
    }
  | {
      type: "session-created" | "session-updated" | "session-removed";
      at: string;
      session: DaemonSessionSummary;
    }
  | {
      type: "session-notify";
      at: string;
      session: DaemonSessionSummary;
    }
  | {
      type: "daemon-error";
      at: string;
      code: DaemonErrorCode | string;
      message: string;
      sessionId?: string;
    }
  | {
      type: "debug-log";
      at: string;
      source: string;
      message: string;
      level?: "debug" | "info" | "warn" | "error";
      sessionId?: string;
      scenarioId?: string;
      data?: unknown;
    };

export type DaemonSessionEvent = Extract<
  DaemonEvent,
  { type: "session-created" | "session-updated" | "session-removed" }
>;

export interface DaemonWebSocketScope {
  family: DaemonEventFamily;
  sessionId?: string;
}

export interface DaemonWebSocketMessageEvent {
  data: string;
}

export interface DaemonWebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: DaemonWebSocketMessageEvent) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  readyState: number;
  send(data: string): void;
  close(): void;
}

export type DaemonWebSocketFactory = (url: string) => DaemonWebSocketLike;

export type DaemonWebSocketClientMessage =
  | {
      type: "subscribe";
      requestId?: string;
      scopes: DaemonWebSocketScope[];
    }
  | {
      type: "unsubscribe";
      requestId?: string;
      scopes: DaemonWebSocketScope[];
    }
  | {
      type: "action";
      requestId: string;
      sessionId: string;
      method: string;
      path: string;
      body?: unknown;
    }
  | {
      type: "ping";
      requestId?: string;
    }
  | {
      type: "client-state";
      visible: boolean;
      activeSessionId: string | null;
    };

export type DaemonWebSocketServerMessage =
  | {
      type: "snapshot";
      at: string;
      scope: DaemonWebSocketScope;
      payload: unknown;
    }
  | {
      type: "event";
      at: string;
      scope: DaemonWebSocketScope;
      payload: unknown;
    }
  | {
      type: "action-result";
      requestId: string;
      ok: true;
      status: number;
      payload?: unknown;
    }
  | {
      type: "error";
      requestId?: string;
      code: DaemonErrorCode | string;
      message: string;
    }
  | {
      type: "pong";
      requestId?: string;
      at: string;
    }
  | {
      type: "heartbeat";
      at: string;
    };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

export function isDaemonWebSocketScope(value: unknown): value is DaemonWebSocketScope {
  if (!isRecord(value)) return false;
  if (!PLANNOTATOR_DAEMON_EVENT_FAMILIES.includes(value.family as DaemonEventFamily)) return false;
  return value.sessionId === undefined || isString(value.sessionId);
}

function parseScopes(value: unknown): DaemonWebSocketScope[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return null;
  const scopes = value.filter(isDaemonWebSocketScope);
  return scopes.length === value.length ? scopes : null;
}

export function parseDaemonWebSocketClientMessage(
  value: unknown,
): DaemonWebSocketClientMessage | null {
  if (!isRecord(value) || !isString(value.type)) return null;
  const requestId = isString(value.requestId) ? value.requestId : undefined;
  if (value.type === "subscribe" || value.type === "unsubscribe") {
    const scopes = parseScopes(value.scopes);
    if (!scopes) return null;
    return { type: value.type, ...(requestId && { requestId }), scopes };
  }
  if (value.type === "action") {
    if (!isString(value.requestId) || !isString(value.sessionId) || !isString(value.method) || !isString(value.path)) {
      return null;
    }
    return {
      type: "action",
      requestId: value.requestId,
      sessionId: value.sessionId,
      method: value.method,
      path: value.path,
      ...(value.body !== undefined && { body: value.body }),
    };
  }
  if (value.type === "ping") return { type: "ping", ...(requestId && { requestId }) };
  if (value.type === "client-state") {
    if (typeof value.visible !== "boolean") return null;
    const activeSessionId = isString(value.activeSessionId) ? value.activeSessionId : null;
    return { type: "client-state", visible: value.visible, activeSessionId };
  }
  return null;
}

export function parseDaemonWebSocketClientMessageText(
  text: string,
): DaemonWebSocketClientMessage | null {
  try {
    return parseDaemonWebSocketClientMessage(JSON.parse(text));
  } catch {
    return null;
  }
}

export function parseDaemonWebSocketServerMessage(
  value: unknown,
): DaemonWebSocketServerMessage | null {
  if (!isRecord(value) || !isString(value.type)) return null;
  if (value.type === "snapshot" || value.type === "event") {
    if (!isString(value.at) || !isDaemonWebSocketScope(value.scope) || !hasOwn(value, "payload")) {
      return null;
    }
    return {
      type: value.type,
      at: value.at,
      scope: value.scope,
      payload: value.payload,
    };
  }
  if (value.type === "action-result") {
    if (!isString(value.requestId) || value.ok !== true || typeof value.status !== "number") {
      return null;
    }
    return {
      type: "action-result",
      requestId: value.requestId,
      ok: true,
      status: value.status,
      ...(hasOwn(value, "payload") && { payload: value.payload }),
    };
  }
  if (value.type === "error") {
    if (!optionalString(value.requestId) || !isString(value.code) || !isString(value.message)) {
      return null;
    }
    return {
      type: "error",
      ...(value.requestId && { requestId: value.requestId }),
      code: value.code,
      message: value.message,
    };
  }
  if (value.type === "pong") {
    if (!optionalString(value.requestId) || !isString(value.at)) return null;
    return {
      type: "pong",
      ...(value.requestId && { requestId: value.requestId }),
      at: value.at,
    };
  }
  if (value.type === "heartbeat") {
    if (!isString(value.at)) return null;
    return { type: "heartbeat", at: value.at };
  }
  return null;
}

export function parseDaemonWebSocketServerMessageText(
  text: string,
): DaemonWebSocketServerMessage | null {
  try {
    return parseDaemonWebSocketServerMessage(JSON.parse(text));
  } catch {
    return null;
  }
}

export function serializeDaemonWebSocketServerMessage(
  message: DaemonWebSocketServerMessage,
): string {
  return JSON.stringify(message);
}

export function isCompatibleDaemonCapabilities(
  value: unknown,
): value is DaemonCapabilities {
  const caps = value as Partial<DaemonCapabilities> | null;
  return (
    !!caps &&
    caps.protocol === PLANNOTATOR_DAEMON_PROTOCOL &&
    typeof caps.protocolVersion === "number" &&
    caps.protocolVersion >= PLANNOTATOR_DAEMON_MIN_CLIENT_VERSION &&
    typeof caps.minClientVersion === "number" &&
    caps.minClientVersion <= PLANNOTATOR_DAEMON_PROTOCOL_VERSION &&
    caps.transport === "http" &&
    caps.multiSession === true
  );
}
