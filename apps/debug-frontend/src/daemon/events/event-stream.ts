import type { DaemonApiClient } from "../api/client";
import type { DaemonApiResult } from "../api/errors";
import type { ShellDaemonEvent, ShellDaemonStatus, ShellSessionListResponse } from "../contracts";

export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

type IntervalHandle = ReturnType<typeof setInterval> & { unref?: () => void };
type SetIntervalLike = (callback: () => void, intervalMs: number) => IntervalHandle;
type ClearIntervalLike = (handle: IntervalHandle) => void;

export interface DaemonEventStreamOptions {
  client: Pick<DaemonApiClient, "getEventsUrl" | "getStatus" | "listSessions">;
  onEvent(event: ShellDaemonEvent): void;
  onState(state: "connecting" | "open" | "polling" | "error"): void;
  onError(message: string): void;
  eventSourceFactory?: (url: string) => EventSourceLike;
  pollIntervalMs?: number;
  setIntervalFn?: SetIntervalLike;
  clearIntervalFn?: ClearIntervalLike;
}

export interface DaemonEventStreamController {
  stop(): void;
}

const DAEMON_EVENT_TYPES = [
  "snapshot",
  "daemon-status",
  "session-created",
  "session-updated",
  "session-removed",
  "daemon-error",
  "debug-log",
] as const;

export function parseDaemonEventPayload(payload: string): ShellDaemonEvent | null {
  try {
    const value = JSON.parse(payload) as Partial<ShellDaemonEvent> | null;
    if (!value || typeof value !== "object" || typeof value.type !== "string") return null;
    if (!DAEMON_EVENT_TYPES.includes(value.type as (typeof DAEMON_EVENT_TYPES)[number]))
      return null;
    if (typeof value.at !== "string") return null;
    return value as ShellDaemonEvent;
  } catch {
    return null;
  }
}

export function connectDaemonEvents(
  options: DaemonEventStreamOptions,
): DaemonEventStreamController {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const setIntervalFn: SetIntervalLike =
    options.setIntervalFn ??
    ((callback, intervalMs) => setInterval(callback, intervalMs) as IntervalHandle);
  const clearIntervalFn: ClearIntervalLike =
    options.clearIntervalFn ?? ((handle) => clearInterval(handle));
  let stopped = false;
  let pollingTimer: IntervalHandle | undefined;
  let eventSource: EventSourceLike | undefined;

  const stopPolling = () => {
    if (!pollingTimer) return;
    clearIntervalFn(pollingTimer);
    pollingTimer = undefined;
  };

  const poll = async () => {
    const [statusResult, sessionsResult] = await Promise.all([
      options.client.getStatus(),
      options.client.listSessions({ clean: true }),
    ]);
    if (stopped) return;
    emitPollingResult(statusResult, sessionsResult, {
      onEvent: options.onEvent,
      onError: options.onError,
      onState: options.onState,
    });
  };

  const startPolling = () => {
    if (stopped || pollingTimer) return;
    options.onState("polling");
    void poll();
    pollingTimer = setIntervalFn(() => void poll(), pollIntervalMs);
    pollingTimer.unref?.();
  };

  const factory = options.eventSourceFactory ?? defaultEventSourceFactory();
  if (!factory) {
    startPolling();
    return { stop };
  }

  options.onState("connecting");
  eventSource = factory(options.client.getEventsUrl());
  eventSource.onopen = () => {
    if (!stopped) options.onState("open");
  };
  eventSource.onerror = () => {
    if (stopped) return;
    options.onError("Daemon event stream disconnected; falling back to polling.");
    options.onState("error");
    eventSource?.close();
    eventSource = undefined;
    startPolling();
  };

  for (const eventType of DAEMON_EVENT_TYPES) {
    eventSource.addEventListener(eventType, (event) => {
      const parsed = parseDaemonEventPayload(event.data);
      if (parsed && !stopped) options.onEvent(parsed);
    });
  }

  return { stop };

  function stop() {
    stopped = true;
    stopPolling();
    eventSource?.close();
    eventSource = undefined;
  }
}

function defaultEventSourceFactory(): ((url: string) => EventSourceLike) | undefined {
  if (typeof EventSource === "undefined") return undefined;
  return (url) => new EventSource(url);
}

function emitPollingResult(
  statusResult: DaemonApiResult<ShellDaemonStatus>,
  sessionsResult: DaemonApiResult<ShellSessionListResponse>,
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
