import type { DaemonApiClient } from "../api/client";
import type { DaemonApiResult } from "../api/errors";
import type {
  DaemonLifecycleEvent,
  DaemonStatusSnapshot,
  DaemonServerMessage,
  SessionListResponse,
} from "../contracts";
import {
  getDaemonHubClient,
  type DaemonHubConnectionState,
  type WebSocketFactory,
} from "./hub-client";

export interface DaemonEventStreamOptions {
  client: Pick<DaemonApiClient, "getWebSocketUrl" | "getStatus" | "listSessions">;
  onEvent(event: DaemonLifecycleEvent): void;
  onState(state: DaemonHubConnectionState | "polling"): void;
  onError(message: string): void;
  onSessionNotify?(session: { id: string; mode: string; project: string; label: string }): void;
  webSocketFactory?: WebSocketFactory;
  fallbackPollMs?: number;
}

export interface DaemonEventStreamController {
  stop(): void;
  reportActiveSession(sessionId: string | null): void;
}

const DAEMON_EVENT_TYPES = [
  "snapshot",
  "daemon-status",
  "session-created",
  "session-updated",
  "session-removed",
  "session-notify",
  "daemon-error",
  "debug-log",
] as const;
const DEFAULT_FALLBACK_POLL_MS = 2_000;

export function parseDaemonEventPayload(payload: unknown): DaemonLifecycleEvent | null {
  const value = payload as Partial<DaemonLifecycleEvent> | null;
  if (!value || typeof value !== "object" || typeof value.type !== "string") return null;
  if (!DAEMON_EVENT_TYPES.includes(value.type as (typeof DAEMON_EVENT_TYPES)[number])) return null;
  if (typeof value.at !== "string") return null;
  return value as DaemonLifecycleEvent;
}

export function connectDaemonEvents(
  options: DaemonEventStreamOptions,
): DaemonEventStreamController {
  let stopped = false;
  let pollingTimer: ReturnType<typeof setInterval> | undefined;
  let pollingInFlight = false;
  const client = getDaemonHubClient(options.client.getWebSocketUrl(), options.webSocketFactory);
  const fallbackPollMs = options.fallbackPollMs ?? DEFAULT_FALLBACK_POLL_MS;

  const emitSnapshot = async () => {
    if (stopped || pollingInFlight) return;
    pollingInFlight = true;
    let statusResult: DaemonApiResult<DaemonStatusSnapshot>;
    let sessionsResult: DaemonApiResult<SessionListResponse>;
    try {
      [statusResult, sessionsResult] = await Promise.all([
        options.client.getStatus(),
        options.client.listSessions({ clean: true }),
      ]);
    } catch (err) {
      if (!stopped) {
        options.onError(err instanceof Error ? err.message : "Daemon polling failed.");
      }
      return;
    } finally {
      pollingInFlight = false;
    }
    if (stopped) return;
    emitPollingResult(statusResult, sessionsResult, {
      onEvent: options.onEvent,
      onError: options.onError,
      onState: options.onState,
    });
  };

  let currentActiveSessionId: string | null = null;
  const pendingNotifications: { id: string; mode: string; project: string; label: string }[] = [];

  const sendClientState = () => {
    client.sendClientState(!document.hidden, currentActiveSessionId);
  };

  const handleVisibilityChange = () => {
    if (stopped) return;
    sendClientState();
    if (!document.hidden && pendingNotifications.length > 0 && options.onSessionNotify) {
      for (const n of pendingNotifications.splice(0)) {
        options.onSessionNotify(n);
      }
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);

  const unsubscribe = client.subscribeDaemon(
    (message) => {
      if (stopped) return;
      const event = messageToDaemonEvent(message);
      if (!event) return;
      if (event.type === "session-notify" && "session" in event && options.onSessionNotify) {
        const s = event.session;
        if (!document.hidden) {
          options.onSessionNotify({ id: s.id, mode: s.mode, project: s.project, label: s.label });
        } else {
          pendingNotifications.push({ id: s.id, mode: s.mode, project: s.project, label: s.label });
        }
      }
      options.onEvent(event);
    },
    (state) => {
      if (stopped) return;
      options.onState(state);
      if (state === "open") {
        stopPolling();
        sendClientState();
      }
      if (state === "error" || state === "closed") startPolling();
    },
    (message) => {
      if (!stopped) options.onError(message);
    },
  );

  return { stop, reportActiveSession };

  function reportActiveSession(sessionId: string | null): void {
    currentActiveSessionId = sessionId;
    sendClientState();
  }

  function stop() {
    stopped = true;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    stopPolling();
    unsubscribe();
  }

  function startPolling(): void {
    if (stopped || pollingTimer) return;
    void emitSnapshot();
    pollingTimer = setInterval(() => {
      void emitSnapshot();
    }, fallbackPollMs);
    pollingTimer.unref?.();
  }

  function stopPolling(): void {
    if (!pollingTimer) return;
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
}

function messageToDaemonEvent(message: DaemonServerMessage): DaemonLifecycleEvent | null {
  if (message.type === "snapshot" && message.scope.family === "daemon") {
    const payload = message.payload as {
      status?: DaemonStatusSnapshot;
      sessions?: SessionListResponse["sessions"];
    };
    if (!payload.status || !Array.isArray(payload.sessions)) return null;
    return {
      type: "snapshot",
      at: message.at,
      status: payload.status,
      sessions: payload.sessions,
    };
  }
  if (message.type !== "event" || message.scope.family !== "daemon") return null;
  return parseDaemonEventPayload(message.payload);
}

function emitPollingResult(
  statusResult: DaemonApiResult<DaemonStatusSnapshot>,
  sessionsResult: DaemonApiResult<SessionListResponse>,
  options: Pick<DaemonEventStreamOptions, "onEvent" | "onError" | "onState">,
): void {
  const at = new Date().toISOString();
  if (!statusResult.ok) {
    options.onError(statusResult.error.message);
    return;
  }

  options.onState("polling");

  if (!sessionsResult.ok) {
    options.onError(sessionsResult.error.message);
    options.onEvent({ type: "daemon-status", at, status: statusResult.data });
    return;
  }

  options.onEvent({
    type: "snapshot",
    at,
    status: statusResult.data,
    sessions: sessionsResult.data.sessions,
  });
}
