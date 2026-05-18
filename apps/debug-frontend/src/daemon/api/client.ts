import {
  PLANNOTATOR_DAEMON_PROTOCOL,
  type DaemonErrorResponse,
} from "@plannotator/shared/daemon-protocol";
import type {
  ShellDaemonStatus,
  ShellDeleteSessionResponse,
  ShellSessionBootstrap,
  ShellSessionListResponse,
  ShellSessionResponse,
  ShellSessionSummary,
} from "../contracts";
import { encodeSessionId } from "../../sessions/session-id";
import type { DaemonApiError, DaemonApiResult } from "./errors";

type FetchLike = typeof fetch;

export interface DaemonApiClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface DaemonApiClient {
  getStatus(): Promise<DaemonApiResult<ShellDaemonStatus>>;
  listSessions(options?: { clean?: boolean }): Promise<DaemonApiResult<ShellSessionListResponse>>;
  getSession(sessionId: string): Promise<DaemonApiResult<ShellSessionResponse>>;
  getSessionBootstrap(sessionId: string): Promise<DaemonApiResult<ShellSessionBootstrap>>;
  cancelSession(sessionId: string, reason?: string): Promise<DaemonApiResult<ShellSessionResponse>>;
  deleteSession(sessionId: string): Promise<DaemonApiResult<ShellDeleteSessionResponse>>;
  getEventsUrl(): string;
  getSessionApiUrl(sessionId: string, path: string): string;
  probeSessionApi(
    sessionId: string,
    path: string,
    init?: RequestInit,
  ): Promise<DaemonApiResult<unknown>>;
  runSessionAction(
    session: ShellSessionSummary,
    action: ShellSessionAction,
  ): Promise<DaemonApiResult<unknown>>;
}

type ResponseGuard<T> = (value: unknown) => value is T;

export type ShellSessionAction =
  | "plan-approve"
  | "plan-deny"
  | "review-approve"
  | "review-feedback"
  | "review-exit"
  | "annotate-approve"
  | "annotate-feedback"
  | "annotate-exit"
  | "archive-done";

function joinUrl(baseUrl: string | undefined, path: string): string {
  if (!baseUrl) return path;
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase).toString();
}

function normalizeSessionApiPath(path: string): string {
  const prefixed = path.startsWith("/") ? path : `/${path}`;
  if (prefixed === "/api") return "";
  if (prefixed.startsWith("/api/")) return prefixed.slice(4);
  return prefixed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOkTrue(value: unknown): value is Record<string, unknown> & { ok: true } {
  return isRecord(value) && value.ok === true;
}

function isDaemonErrorResponse(value: unknown): value is DaemonErrorResponse {
  return (
    isRecord(value) &&
    value.ok === false &&
    value.protocol === PLANNOTATOR_DAEMON_PROTOCOL &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

function isDaemonStatus(value: unknown): value is ShellDaemonStatus {
  return (
    hasOkTrue(value) &&
    value.protocol === PLANNOTATOR_DAEMON_PROTOCOL &&
    typeof value.pid === "number" &&
    isRecord(value.endpoint) &&
    typeof value.endpoint.baseUrl === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.activeSessionCount === "number" &&
    typeof value.sessionCount === "number"
  );
}

function isUnknownPayload(_value: unknown): _value is unknown {
  return true;
}

function isSessionSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.mode === "string" &&
    typeof value.status === "string" &&
    typeof value.url === "string" &&
    typeof value.project === "string" &&
    typeof value.label === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isSessionList(value: unknown): value is ShellSessionListResponse {
  return (
    hasOkTrue(value) && Array.isArray(value.sessions) && value.sessions.every(isSessionSummary)
  );
}

function isSessionResponse(value: unknown): value is ShellSessionResponse {
  return hasOkTrue(value) && isSessionSummary((value as { session?: unknown }).session);
}

function isDeleteSessionResponse(value: unknown): value is ShellDeleteSessionResponse {
  return hasOkTrue(value);
}

function isSessionBootstrap(value: unknown): value is ShellSessionBootstrap {
  return (
    isSessionResponse(value) &&
    typeof (value as { apiBase?: unknown }).apiBase === "string" &&
    isRecord((value as { capabilities?: unknown }).capabilities) &&
    Array.isArray((value as { supportedSessionViews?: unknown }).supportedSessionViews)
  );
}

function httpError(status: number, message: string): DaemonApiError {
  return { kind: "http-error", status, message };
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  guard: ResponseGuard<T>,
  init?: RequestInit,
): Promise<DaemonApiResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: "network-error",
        message: cause instanceof Error ? cause.message : "Network request failed.",
        cause,
      },
    };
  }

  const body = await response.text();
  let payload: unknown;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    return {
      ok: false,
      error: {
        kind: "invalid-json",
        status: response.status,
        body,
        message: "Daemon returned a non-JSON response.",
      },
    };
  }

  if (isDaemonErrorResponse(payload)) {
    return {
      ok: false,
      error: {
        kind: "daemon-error",
        status: response.status,
        code: payload.error.code,
        message: payload.error.message,
      },
    };
  }

  if (!response.ok) {
    return { ok: false, error: httpError(response.status, response.statusText || "HTTP error.") };
  }

  if (!guard(payload)) {
    return {
      ok: false,
      error: {
        kind: "invalid-payload",
        message: "Daemon response did not match the frontend contract.",
        value: payload,
      },
    };
  }

  return { ok: true, data: payload };
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function requestForAction(action: ShellSessionAction): { path: string; init: RequestInit } {
  switch (action) {
    case "plan-approve":
      return { path: "/api/approve", init: jsonPost({ planSave: { enabled: false } }) };
    case "plan-deny":
      return {
        path: "/api/deny",
        init: jsonPost({
          feedback: "Plan denied by frontend debug action.",
          planSave: { enabled: false },
        }),
      };
    case "review-approve":
      return {
        path: "/api/feedback",
        init: jsonPost({ approved: true, feedback: "LGTM", annotations: [] }),
      };
    case "review-feedback":
      return {
        path: "/api/feedback",
        init: jsonPost({
          approved: false,
          feedback: "Review feedback from frontend debug action.",
          annotations: [],
        }),
      };
    case "review-exit":
      return { path: "/api/exit", init: jsonPost({}) };
    case "annotate-approve":
      return { path: "/api/approve", init: jsonPost({}) };
    case "annotate-feedback":
      return {
        path: "/api/feedback",
        init: jsonPost({
          feedback: "Annotation feedback from frontend debug action.",
          annotations: [],
        }),
      };
    case "annotate-exit":
      return { path: "/api/exit", init: jsonPost({}) };
    case "archive-done":
      return { path: "/api/done", init: jsonPost({}) };
  }
}

export function createDaemonApiClient(options: DaemonApiClientOptions = {}): DaemonApiClient {
  const fetchImpl = options.fetch ?? fetch;
  const getSessionApiUrl = (sessionId: string, path: string) =>
    joinUrl(
      options.baseUrl,
      `/s/${encodeSessionId(sessionId)}/api${normalizeSessionApiPath(path)}`,
    );
  const probeSessionApi = (sessionId: string, path: string, init?: RequestInit) =>
    requestJson(fetchImpl, getSessionApiUrl(sessionId, path), isUnknownPayload, init);

  return {
    getStatus() {
      return requestJson(fetchImpl, joinUrl(options.baseUrl, "/daemon/status"), isDaemonStatus);
    },

    listSessions(listOptions = {}) {
      const path = listOptions.clean ? "/daemon/sessions?clean=1" : "/daemon/sessions";
      return requestJson(fetchImpl, joinUrl(options.baseUrl, path), isSessionList);
    },

    getSession(sessionId) {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, `/daemon/sessions/${encodeSessionId(sessionId)}`),
        isSessionResponse,
      );
    },

    getSessionBootstrap(sessionId) {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, `/s/${encodeSessionId(sessionId)}/api/session`),
        isSessionBootstrap,
      );
    },

    cancelSession(sessionId, reason) {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, `/daemon/sessions/${encodeSessionId(sessionId)}/cancel`),
        isSessionResponse,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
    },

    deleteSession(sessionId) {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, `/daemon/sessions/${encodeSessionId(sessionId)}`),
        isDeleteSessionResponse,
        { method: "DELETE" },
      );
    },

    getEventsUrl() {
      return joinUrl(options.baseUrl, "/daemon/events");
    },

    getSessionApiUrl(sessionId, path) {
      return getSessionApiUrl(sessionId, path);
    },

    probeSessionApi(sessionId, path, init) {
      return probeSessionApi(sessionId, path, init);
    },

    runSessionAction(session, action) {
      const request = requestForAction(action);
      return probeSessionApi(session.id, request.path, request.init);
    },
  };
}

export const daemonApiClient = createDaemonApiClient();
