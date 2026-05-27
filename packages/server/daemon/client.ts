import {
  createDaemonErrorResponse,
  isCompatibleDaemonCapabilities,
  type DaemonCancelSessionResponse,
  type DaemonCreateSessionRequest,
  type DaemonCreateSessionResponse,
  type DaemonErrorResponse,
  type DaemonSessionResultResponse,
  type DaemonShutdownResponse,
  type DaemonStatus,
} from "@plannotator/shared/daemon-protocol";
import { getServerPort, isRemoteSession } from "../remote";
import { readDaemonState, removeDaemonFiles, type DaemonState, type DaemonStateOptions } from "./state";

export interface DaemonClientOptions extends DaemonStateOptions {
  fetch?: typeof fetch;
  validateEnvironment?: boolean;
  shutdownTimeoutMs?: number;
}

export type DaemonDiscoveryResult =
  | { ok: true; state: DaemonState; status: DaemonStatus; client: DaemonClient }
  | { ok: false; code: "missing" | "stale" | "malformed" | "incompatible" | "unhealthy" | "mismatch"; message: string; state?: unknown };

export class DaemonClient {
  readonly state: DaemonState;
  private readonly fetchImpl: typeof fetch;

  constructor(state: DaemonState, options: Pick<DaemonClientOptions, "fetch"> = {}) {
    this.state = state;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async capabilities(): Promise<unknown> {
    return this.getJson("/daemon/capabilities");
  }

  async status(): Promise<DaemonStatus> {
    return this.getJson("/daemon/status") as Promise<DaemonStatus>;
  }

  async listSessions(options: { clean?: boolean } = {}): Promise<unknown> {
    return this.getJson(options.clean ? "/daemon/sessions?clean=1" : "/daemon/sessions");
  }

  async createSession(request: DaemonCreateSessionRequest): Promise<DaemonCreateSessionResponse | DaemonErrorResponse> {
    return this.requestJson("/daemon/sessions", {
      method: "POST",
      body: JSON.stringify(request),
    }) as Promise<DaemonCreateSessionResponse | DaemonErrorResponse>;
  }

  async waitForResult<T = unknown>(id: string): Promise<DaemonSessionResultResponse<T> | DaemonErrorResponse> {
    return this.getJson(`/daemon/sessions/${encodeURIComponent(id)}/result`) as Promise<DaemonSessionResultResponse<T> | DaemonErrorResponse>;
  }

  async cancelSession(id: string): Promise<DaemonCancelSessionResponse | DaemonErrorResponse> {
    return this.requestJson(`/daemon/sessions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: "{}",
    }) as Promise<DaemonCancelSessionResponse | DaemonErrorResponse>;
  }

  async shutdown(): Promise<DaemonShutdownResponse | DaemonErrorResponse> {
    return this.requestJson("/daemon/shutdown", {
      method: "POST",
      body: "{}",
    }) as Promise<DaemonShutdownResponse | DaemonErrorResponse>;
  }

  async getJson(path: string): Promise<unknown> {
    return this.requestJson(path, { method: "GET" });
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (path !== "/daemon/capabilities") {
      const token = stateAuthToken(this.state);
      if (token && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${token}`);
      }
    }

    const res = await this.fetchImpl(`${this.state.baseUrl}${path}`, {
      ...init,
      headers,
    });
    try {
      return await res.json();
    } catch {
      return createDaemonErrorResponse("daemon-unhealthy", `Daemon returned non-JSON response with status ${res.status}.`);
    }
  }
}

function stateBaseUrl(state: unknown): string | undefined {
  const baseUrl = (state as { baseUrl?: unknown } | null)?.baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}

function statePid(state: unknown): number | undefined {
  const pid = (state as { pid?: unknown } | null)?.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function stateAuthToken(state: unknown): string | undefined {
  const token = (state as { authToken?: unknown } | null)?.authToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function withDaemonAuth(state: unknown, headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  const token = stateAuthToken(state);
  if (token && !next.has("authorization")) {
    next.set("authorization", `Bearer ${token}`);
  }
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DaemonPollEvent =
  | { kind: "missing-base-url" }
  | { kind: "pid-exited" }
  | { kind: "unreachable" }
  | { kind: "status"; ok: boolean; pid?: unknown };

function defaultIsAlive(targetPid: number): boolean {
  try {
    process.kill(targetPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollDaemonStatus(
  state: unknown,
  options: DaemonClientOptions,
  evaluate: (event: DaemonPollEvent) => boolean | undefined,
): Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = stateBaseUrl(state);
  const pid = statePid(state);
  const isAlive = options.isAlive ?? defaultIsAlive;
  const deadline = Date.now() + (options.shutdownTimeoutMs ?? 3_000);

  if (!baseUrl) return evaluate({ kind: "missing-base-url" }) ?? false;

  while (Date.now() < deadline) {
    if (pid && !isAlive(pid)) return evaluate({ kind: "pid-exited" }) ?? false;
    try {
      const res = await fetchImpl(`${baseUrl}/daemon/status`, {
        headers: withDaemonAuth(state),
      });
      const status = await res.json().catch(() => null) as { pid?: unknown } | null;
      const decision = evaluate({ kind: "status", ok: res.ok, pid: status?.pid });
      if (decision !== undefined) return decision;
    } catch {
      const decision = evaluate({ kind: "unreachable" });
      if (decision !== undefined) return decision;
    }
    await sleep(100);
  }

  return false;
}

async function waitForDaemonReachable(
  state: unknown,
  options: DaemonClientOptions = {},
): Promise<boolean> {
  const pid = statePid(state);
  return pollDaemonStatus(state, options, (event) => {
    if (event.kind === "missing-base-url" || event.kind === "pid-exited") return false;
    if (event.kind !== "status") return undefined;
    if (event.ok && (!pid || event.pid === pid)) return true;
    if (pid && event.pid !== pid) return false;
    return undefined;
  });
}

export async function waitForDaemonShutdown(
  state: unknown,
  options: DaemonClientOptions = {},
): Promise<boolean> {
  const pid = statePid(state);
  return pollDaemonStatus(state, options, (event) => {
    switch (event.kind) {
      case "missing-base-url":
      case "pid-exited":
      case "unreachable":
        return true;
      case "status":
        if (!event.ok) return true;
        if (pid && event.pid !== pid) return true;
        return undefined;
    }
  });
}

export async function cleanupDaemonState(state: unknown, options: DaemonClientOptions = {}): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = stateBaseUrl(state);
  let shutdownAccepted = false;
  if (baseUrl) {
    let endpointResponded = false;
    try {
      const res = await fetchImpl(`${baseUrl}/daemon/shutdown`, {
        method: "POST",
        headers: withDaemonAuth(state, { "content-type": "application/json" }),
        body: "{}",
      });
      endpointResponded = true;
      shutdownAccepted = res.ok;
      if (!shutdownAccepted) {
        if (res.status === 404 || res.status === 405) {
          removeDaemonFiles(options);
          return;
        }
        throw new Error(`The existing Plannotator daemon rejected shutdown with HTTP ${res.status}.`);
      }
    } catch (err) {
      // Best effort only. Do not signal the recorded PID here; stale daemon
      // state can outlive the process and the PID may now belong to something else.
      if (!endpointResponded) {
        if (await waitForDaemonReachable(state, options)) {
          const retry = await fetchImpl(`${baseUrl}/daemon/shutdown`, {
            method: "POST",
            headers: withDaemonAuth(state, { "content-type": "application/json" }),
            body: "{}",
          });
          if (!retry.ok) {
            throw new Error(`The existing Plannotator daemon rejected shutdown with HTTP ${retry.status}.`);
          }
          const stopped = await waitForDaemonShutdown(state, options);
          if (!stopped) {
            throw new Error("Timed out waiting for the existing Plannotator daemon to stop.");
          }
        }
        removeDaemonFiles(options);
        return;
      }
      throw err;
    }
  }
  if (shutdownAccepted) {
    const stopped = await waitForDaemonShutdown(state, options);
    if (!stopped) {
      throw new Error("Timed out waiting for the existing Plannotator daemon to stop.");
    }
  }
  removeDaemonFiles(options);
}

export async function discoverDaemon(options: DaemonClientOptions = {}): Promise<DaemonDiscoveryResult> {
  const stateResult = readDaemonState(options);
  if (stateResult.kind === "missing") {
    return { ok: false, code: "missing", message: "No Plannotator daemon state found." };
  }
  if (stateResult.kind === "malformed") {
    removeDaemonFiles(options);
    return { ok: false, code: "malformed", message: stateResult.error };
  }
  if (stateResult.kind === "stale") {
    removeDaemonFiles(options);
    return { ok: false, code: "stale", message: `Stale Plannotator daemon state for PID ${stateResult.state.pid}.`, state: stateResult.state };
  }
  if (stateResult.kind === "incompatible") {
    return { ok: false, code: "incompatible", message: "The daemon state file is not compatible with this Plannotator version.", state: stateResult.state };
  }

  const client = new DaemonClient(stateResult.state, options);
  try {
    const caps = await client.capabilities();
    if (!isCompatibleDaemonCapabilities(caps)) {
      return { ok: false, code: "incompatible", message: "The running daemon uses an incompatible protocol.", state: stateResult.state };
    }

    const status = await client.status();
    if (status.ok !== true || status.pid !== stateResult.state.pid) {
      return { ok: false, code: "unhealthy", message: "The running daemon did not return a matching status.", state: stateResult.state };
    }

    if (options.validateEnvironment !== false) {
      const desiredRemote = isRemoteSession();
      if (status.endpoint.isRemote !== desiredRemote) {
        return {
          ok: false,
          code: "mismatch",
          message: `The running Plannotator daemon was started in ${status.endpoint.isRemote ? "remote" : "local"} mode, but this command wants ${desiredRemote ? "remote" : "local"} mode. Run 'plannotator daemon stop' and retry.`,
          state: stateResult.state,
        };
      }

      const desiredPort = getServerPort();
      if (desiredPort !== 0 && status.endpoint.port !== desiredPort) {
        return {
          ok: false,
          code: "mismatch",
          message: `The running Plannotator daemon is on port ${status.endpoint.port}, but this command wants port ${desiredPort}. Run 'plannotator daemon stop' and retry.`,
          state: stateResult.state,
        };
      }
    }

    return { ok: true, state: stateResult.state, status, client };
  } catch (err) {
    return {
      ok: false,
      code: "unhealthy",
      message: err instanceof Error ? err.message : "Could not reach the Plannotator daemon.",
      state: stateResult.state,
    };
  }
}
