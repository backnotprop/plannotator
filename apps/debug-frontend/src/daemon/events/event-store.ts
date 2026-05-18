import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ShellDaemonEvent, ShellDaemonStatus, ShellSessionSummary } from "../contracts";

const MAX_EVENTS = 100;
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "expired", "failed"]);

export type DaemonEventConnectionState = "idle" | "connecting" | "open" | "polling" | "error";

export interface DaemonDebugStateSnapshot {
  connectionState: DaemonEventConnectionState;
  events: ShellDaemonEvent[];
  sessions: ShellSessionSummary[];
  status?: ShellDaemonStatus;
  lastError?: string;
  lastUpdatedAt?: string;
}

export interface DaemonDebugState extends DaemonDebugStateSnapshot {
  setConnectionState(state: DaemonEventConnectionState): void;
  setError(message: string): void;
  replaceSessions(sessions: ShellSessionSummary[]): void;
  applyEvent(event: ShellDaemonEvent): void;
  reset(): void;
}

export function createInitialDaemonDebugState(): DaemonDebugStateSnapshot {
  return {
    connectionState: "idle",
    events: [],
    sessions: [],
  };
}

export function applyDaemonEvent(state: DaemonDebugStateSnapshot, event: ShellDaemonEvent): void {
  state.events = [event, ...state.events].slice(0, MAX_EVENTS);
  state.lastUpdatedAt = event.at;

  if (event.type === "snapshot") {
    state.status = event.status;
    state.sessions = event.sessions;
    return;
  }

  if (event.type === "daemon-status") {
    state.status = event.status;
    return;
  }

  if (event.type === "daemon-error") {
    state.lastError = event.message;
    return;
  }

  if (event.type === "debug-log") {
    return;
  }

  const existingIndex = state.sessions.findIndex((session) => session.id === event.session.id);
  if (event.type === "session-removed" || TERMINAL_STATUSES.has(event.session.status)) {
    if (existingIndex >= 0) state.sessions.splice(existingIndex, 1);
    return;
  }

  if (existingIndex >= 0) {
    state.sessions[existingIndex] = event.session;
  } else {
    state.sessions.unshift(event.session);
  }
}

export const useDaemonDebugStore = create<DaemonDebugState>()(
  immer((set) => ({
    ...createInitialDaemonDebugState(),

    setConnectionState(connectionState) {
      set((state) => {
        state.connectionState = connectionState;
      });
    },

    setError(message) {
      set((state) => {
        state.connectionState = "error";
        state.lastError = message;
      });
    },

    replaceSessions(sessions) {
      set((state) => {
        state.sessions = sessions;
      });
    },

    applyEvent(event) {
      set((state) => {
        applyDaemonEvent(state, event);
      });
    },

    reset() {
      set(createInitialDaemonDebugState());
    },
  })),
);
