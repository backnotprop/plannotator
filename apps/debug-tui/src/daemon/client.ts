import type { DaemonStatus } from "@plannotator/shared/daemon-protocol";

export interface SimulatorDaemonSession {
  id: string;
  mode: "plan" | "review" | "annotate" | "archive" | string;
  status: string;
  url: string;
  project: string;
  label: string;
}

export interface SimulatorDaemonClient {
  getStatus(): Promise<DaemonStatus>;
  listSessions(): Promise<SimulatorDaemonSession[]>;
  postDebugLog(event: SimulatorDebugLogEvent): Promise<void>;
  completeSession(
    session: { url: string; mode: string },
    completion: "plan" | "review" | "annotate" | "archive",
  ): Promise<unknown>;
  shutdown(): Promise<void>;
}

export interface SimulatorDebugLogEvent {
  at?: string;
  source: string;
  scenarioId?: string;
  message: string;
  level?: "debug" | "info" | "warn" | "error";
  data?: unknown;
}

export interface SimulatorDaemonClientOptions {
  authToken?: string;
}

export function createSimulatorDaemonClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: SimulatorDaemonClientOptions = {},
): SimulatorDaemonClient {
  const daemonInit = (init?: RequestInit): RequestInit => withDaemonAuth(init, options.authToken);

  return {
    async getStatus() {
      return readJson<DaemonStatus>(fetchImpl, `${baseUrl}/daemon/status`, daemonInit());
    },

    async listSessions() {
      const payload = await readJson<{ ok: true; sessions: SimulatorDaemonSession[] }>(
        fetchImpl,
        `${baseUrl}/daemon/sessions?clean=1`,
        daemonInit(),
      );
      return payload.sessions;
    },

    async postDebugLog(event) {
      await readJson(fetchImpl, `${baseUrl}/daemon/events/debug`, daemonInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }));
    },

    completeSession(session, completion) {
      return completeSession(fetchImpl, session.url, completion);
    },

    async shutdown() {
      await readJson(fetchImpl, `${baseUrl}/daemon/shutdown`, daemonInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }));
    },
  };
}

export function authTokenFromBrowserUrl(browserUrl: string | undefined): string | undefined {
  if (!browserUrl) return undefined;
  try {
    return new URL(browserUrl).searchParams.get("plannotator_auth") ?? undefined;
  } catch {
    return undefined;
  }
}

export async function completeSession(
  fetchImpl: typeof fetch,
  sessionUrl: string,
  completion: "plan" | "review" | "annotate" | "archive",
): Promise<unknown> {
  switch (completion) {
    case "plan":
      return readJson(fetchImpl, `${sessionUrl}/api/approve`, postJson({ planSave: { enabled: false } }));
    case "review":
      return readJson(
        fetchImpl,
        `${sessionUrl}/api/feedback`,
        postJson({ approved: true, feedback: "LGTM", annotations: [] }),
      );
    case "annotate":
      return readJson(fetchImpl, `${sessionUrl}/api/approve`, postJson({}));
    case "archive":
      return readJson(fetchImpl, `${sessionUrl}/api/done`, postJson({}));
  }
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function withDaemonAuth(init: RequestInit = {}, authToken?: string): RequestInit {
  if (!authToken) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  return { ...init, headers };
}

async function readJson<T = unknown>(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Daemon request failed (${response.status}): ${text}`);
  }
  return payload as T;
}
