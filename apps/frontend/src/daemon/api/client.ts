import {
  PLANNOTATOR_DAEMON_PROTOCOL,
  type DaemonErrorResponse,
} from "@plannotator/shared/daemon-protocol";
import type {
  DaemonStatusSnapshot,
  DeleteSessionResponse,
  ProjectEntry,
  ProjectListResponse,
  SessionBootstrap,
  SessionListResponse,
  SessionResponse,
  SessionSummary,
  WorktreeListResponse,
  DirectoryListResponse,
  PRListResponse,
  PRDetailedListResponse,
} from "../contracts";
import {
  DaemonHubActionError,
  DaemonHubOpenError,
  getDaemonHubClient,
  type WebSocketFactory,
} from "../events/hub-client";
import type { DaemonApiError, DaemonApiResult } from "./errors";

type FetchLike = typeof fetch;

export interface DaemonApiClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
}

export type SessionAction =
  | "plan-approve"
  | "plan-deny"
  | "review-approve"
  | "review-feedback"
  | "review-exit"
  | "annotate-approve"
  | "annotate-feedback"
  | "annotate-exit"
  | "goal-setup-submit"
  | "goal-setup-exit";

export interface DaemonApiClient {
  getStatus(): Promise<DaemonApiResult<DaemonStatusSnapshot>>;
  listSessions(options?: { clean?: boolean }): Promise<DaemonApiResult<SessionListResponse>>;
  getSession(sessionId: string): Promise<DaemonApiResult<SessionResponse>>;
  getSessionBootstrap(sessionId: string): Promise<DaemonApiResult<SessionBootstrap>>;
  cancelSession(sessionId: string, reason?: string): Promise<DaemonApiResult<SessionResponse>>;
  deleteSession(sessionId: string): Promise<DaemonApiResult<DeleteSessionResponse>>;
  getWebSocketUrl(): string;
  getSessionApiUrl(sessionId: string, path: string): string;
  probeSessionApi(
    sessionId: string,
    path: string,
    init?: RequestInit,
  ): Promise<DaemonApiResult<unknown>>;
  runSessionAction(
    session: SessionSummary,
    action: SessionAction,
  ): Promise<DaemonApiResult<unknown>>;
  listProjects(): Promise<DaemonApiResult<ProjectListResponse>>;
  addProject(
    cwd: string,
    name?: string,
  ): Promise<DaemonApiResult<{ ok: true; project: ProjectEntry }>>;
  removeProject(cwd: string, clean?: boolean): Promise<DaemonApiResult<{ ok: true }>>;
  listWorktrees(cwd: string): Promise<DaemonApiResult<WorktreeListResponse>>;
  listDirectories(path?: string): Promise<DaemonApiResult<DirectoryListResponse>>;
  listPRs(cwd: string): Promise<DaemonApiResult<PRListResponse>>;
  listDetailedPRs(cwd: string): Promise<DaemonApiResult<PRDetailedListResponse>>;
  createReviewSession(cwd: string, prUrl?: string): Promise<DaemonApiResult<SessionResponse>>;
}

type ResponseGuard<T> = (value: unknown) => value is T;

function encodeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function joinUrl(baseUrl: string | undefined, path: string): string {
  if (!baseUrl) return path;
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase).toString();
}

function websocketUrl(baseUrl: string | undefined, path: string): string {
  const joined = joinUrl(baseUrl, path);
  const url = joined.startsWith("/")
    ? new URL(joined, typeof window === "undefined" ? "http://localhost" : window.location.href)
    : new URL(joined);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
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

function isDaemonStatus(value: unknown): value is DaemonStatusSnapshot {
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

function isSessionList(value: unknown): value is SessionListResponse {
  return (
    hasOkTrue(value) && Array.isArray(value.sessions) && value.sessions.every(isSessionSummary)
  );
}

function isSessionResponse(value: unknown): value is SessionResponse {
  return hasOkTrue(value) && isSessionSummary((value as { session?: unknown }).session);
}

function isDeleteSessionResponse(value: unknown): value is DeleteSessionResponse {
  return hasOkTrue(value);
}

function isProjectEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.cwd === "string" &&
    typeof value.lastSeen === "string"
  );
}

function isProjectList(value: unknown): value is ProjectListResponse {
  return hasOkTrue(value) && Array.isArray(value.projects) && value.projects.every(isProjectEntry);
}

function isProjectResponse(value: unknown): value is { ok: true; project: ProjectEntry } {
  return hasOkTrue(value) && isProjectEntry((value as { project?: unknown }).project);
}

function isWorktreeList(value: unknown): value is WorktreeListResponse {
  return hasOkTrue(value) && Array.isArray((value as { worktrees?: unknown }).worktrees);
}

function isDirectoryList(value: unknown): value is DirectoryListResponse {
  return hasOkTrue(value) && Array.isArray((value as { dirs?: unknown }).dirs);
}

function isPRList(value: unknown): value is PRListResponse {
  return hasOkTrue(value) && Array.isArray((value as { prs?: unknown }).prs);
}

function isPRDetailedList(value: unknown): value is PRDetailedListResponse {
  return hasOkTrue(value) && Array.isArray((value as { prs?: unknown }).prs);
}

function isSessionBootstrap(value: unknown): value is SessionBootstrap {
  return (
    isSessionResponse(value) &&
    typeof (value as { apiBase?: unknown }).apiBase === "string" &&
    isRecord((value as { capabilities?: unknown }).capabilities) &&
    Array.isArray((value as { supportedSessionViews?: unknown }).supportedSessionViews)
  );
}

function httpError(status: number, message: string, payload?: unknown): DaemonApiError {
  return {
    kind: "http-error",
    status,
    message,
    ...(payload !== undefined && { payload }),
  };
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
    if (isRecord(payload.error) && typeof payload.error.message === "string") {
      return payload.error.message;
    }
  }
  return fallback;
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

function requestForAction(action: SessionAction): { path: string; init: RequestInit } {
  switch (action) {
    case "plan-approve":
      return { path: "/api/approve", init: jsonPost({ planSave: { enabled: false } }) };
    case "plan-deny":
      return {
        path: "/api/deny",
        init: jsonPost({ feedback: "Plan denied.", planSave: { enabled: false } }),
      };
    case "review-approve":
      return {
        path: "/api/feedback",
        init: jsonPost({ approved: true, feedback: "LGTM", annotations: [] }),
      };
    case "review-feedback":
      return {
        path: "/api/feedback",
        init: jsonPost({ approved: false, feedback: "", annotations: [] }),
      };
    case "review-exit":
      return { path: "/api/exit", init: jsonPost({}) };
    case "annotate-approve":
      return { path: "/api/approve", init: jsonPost({}) };
    case "annotate-feedback":
      return { path: "/api/feedback", init: jsonPost({ feedback: "", annotations: [] }) };
    case "annotate-exit":
      return { path: "/api/exit", init: jsonPost({}) };
    case "goal-setup-submit":
      return { path: "/api/goal-setup/submit", init: jsonPost({ answers: [], facts: [] }) };
    case "goal-setup-exit":
      return { path: "/api/exit", init: jsonPost({}) };
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

    getWebSocketUrl() {
      return websocketUrl(options.baseUrl, "/daemon/ws");
    },

    getSessionApiUrl(sessionId, path) {
      return getSessionApiUrl(sessionId, path);
    },

    probeSessionApi(sessionId, path, init) {
      return probeSessionApi(sessionId, path, init);
    },

    async runSessionAction(session, action) {
      const request = requestForAction(action);
      const body = request.init.body ? JSON.parse(String(request.init.body)) : undefined;
      try {
        const result = await getDaemonHubClient(
          websocketUrl(options.baseUrl, "/daemon/ws"),
          options.webSocketFactory,
        ).runAction({
          sessionId: session.id,
          method: request.init.method ?? "GET",
          path: request.path,
          body,
        });
        if (result.status < 200 || result.status >= 300) {
          return {
            ok: false,
            error: httpError(
              result.status,
              errorMessageFromPayload(result.payload, "Daemon action failed."),
              result.payload,
            ),
          };
        }
        return { ok: true, data: result.payload };
      } catch (cause) {
        if (
          cause instanceof DaemonHubOpenError ||
          (cause instanceof DaemonHubActionError && cause.code === "unauthorized")
        ) {
          return probeSessionApi(session.id, request.path, request.init);
        }
        return {
          ok: false,
          error: {
            kind: "network-error",
            message: cause instanceof Error ? cause.message : "Daemon action failed.",
            cause,
          },
        };
      }
    },

    listProjects() {
      return requestJson(fetchImpl, joinUrl(options.baseUrl, "/daemon/projects"), isProjectList);
    },

    addProject(cwd, name) {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, "/daemon/projects"),
        isProjectResponse,
        jsonPost({ cwd, ...(name && { name }) }),
      );
    },

    removeProject(cwd, clean) {
      const params = new URLSearchParams({ cwd });
      if (clean) params.set("clean", "1");
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, `/daemon/projects?${params}`),
        isDeleteSessionResponse,
        { method: "DELETE" },
      );
    },

    listDirectories(path = "~") {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, `/daemon/fs/list?path=${encodeURIComponent(path)}`),
        isDirectoryList,
      );
    },

    listWorktrees(cwd) {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, `/daemon/projects/worktrees?cwd=${encodeURIComponent(cwd)}`),
        isWorktreeList,
      );
    },

    listPRs(cwd) {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, `/daemon/projects/prs?cwd=${encodeURIComponent(cwd)}`),
        isPRList,
      );
    },

    listDetailedPRs(cwd) {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, `/daemon/projects/prs/detailed?cwd=${encodeURIComponent(cwd)}`),
        isPRDetailedList,
      );
    },

    createReviewSession(cwd, prUrl) {
      return requestJson(
        fetchImpl,
        joinUrl(options.baseUrl, "/daemon/sessions"),
        isSessionResponse,
        jsonPost({
          request: {
            action: "review",
            origin: "plannotator-frontend",
            cwd,
            ...(prUrl && { prUrl }),
          },
        }),
      );
    },

  };
}

export const daemonApiClient = createDaemonApiClient();
