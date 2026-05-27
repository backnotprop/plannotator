import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { DaemonLifecycleEvent, DaemonStatusSnapshot, SessionSummary } from "../contracts";

const MAX_EVENTS = 100;
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "expired", "failed"]);

export type DaemonConnectionState = "idle" | "connecting" | "open" | "closed" | "polling" | "error";

export interface DaemonEventState {
  connectionState: DaemonConnectionState;
  events: DaemonLifecycleEvent[];
  sessions: SessionSummary[];
  status?: DaemonStatusSnapshot;
  lastError?: string;
  lastUpdatedAt?: string;
}

export interface DaemonEventStoreActions {
  setConnectionState(state: DaemonConnectionState): void;
  setError(message: string): void;
  replaceSessions(sessions: SessionSummary[]): void;
  applyEvent(event: DaemonLifecycleEvent): void;
  reset(): void;
}

export type DaemonEventStore = DaemonEventState & DaemonEventStoreActions;

function createInitialState(): DaemonEventState {
  return {
    connectionState: "idle",
    events: [],
    sessions: [],
  };
}

export function applyDaemonEvent(state: DaemonEventState, event: DaemonLifecycleEvent): void {
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
  if (event.type === "session-removed") {
    if (existingIndex >= 0) state.sessions.splice(existingIndex, 1);
    return;
  }

  if (existingIndex >= 0) {
    state.sessions[existingIndex] = event.session;
  } else {
    state.sessions.unshift(event.session);
  }
}

export const useDaemonEventStore = create<DaemonEventStore>()(
  immer((set) => ({
    ...createInitialState(),

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
      set(createInitialState());
    },
  })),
);
