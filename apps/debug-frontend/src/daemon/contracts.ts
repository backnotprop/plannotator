import type {
  DaemonEndpoint,
  DaemonErrorResponse,
  DaemonEvent,
  DaemonSessionBootstrapResponse,
  DaemonSessionStatus,
  DaemonSessionSummary,
  DaemonSessionView,
  DaemonStatus,
} from "@plannotator/shared/daemon-protocol";

export type ShellSessionView = DaemonSessionView;
export type ShellSessionMode = ShellSessionView | (string & {});

export interface ShellSessionSummary extends Omit<DaemonSessionSummary, "mode"> {
  mode: ShellSessionMode;
}

export interface ShellDaemonStatus extends Omit<DaemonStatus, "endpoint"> {
  endpoint: DaemonEndpoint;
}

export interface ShellSessionBootstrap extends Omit<DaemonSessionBootstrapResponse, "session"> {
  session: ShellSessionSummary;
}

export interface ShellSessionListResponse {
  ok: true;
  sessions: ShellSessionSummary[];
}

export interface ShellSessionResponse {
  ok: true;
  session: ShellSessionSummary;
}

export interface ShellDeleteSessionResponse {
  ok: true;
}

export type ShellDaemonResponse<T> = T | DaemonErrorResponse;

export type ShellSessionLifecycleStatus = DaemonSessionStatus;
export type ShellDaemonEvent =
  | (Omit<Extract<DaemonEvent, { type: "snapshot" }>, "sessions"> & {
      sessions: ShellSessionSummary[];
    })
  | Extract<DaemonEvent, { type: "daemon-status" | "daemon-error" }>
  | Extract<DaemonEvent, { type: "debug-log" }>
  | (Omit<
      Extract<DaemonEvent, { type: "session-created" | "session-updated" | "session-removed" }>,
      "session"
    > & {
      session: ShellSessionSummary;
    });
