import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { DaemonApiError } from "../../daemon/api/errors";
import type { ShellSessionBootstrap, ShellSessionSummary } from "../types";

export type SessionLoadState = "idle" | "loading" | "ready" | "error";

export interface SessionRecordState {
  loadState: SessionLoadState;
  summary?: ShellSessionSummary;
  bootstrap?: ShellSessionBootstrap;
  error?: DaemonApiError;
}

export interface SessionStoreState {
  selectedSessionId?: string;
  sessions: Record<string, SessionRecordState>;
  sessionOrder: string[];
}

export interface SessionStoreActions {
  setSelectedSession(sessionId: string | undefined): void;
  setSessions(sessions: ShellSessionSummary[]): void;
  markLoading(sessionId: string): void;
  setBootstrap(bootstrap: ShellSessionBootstrap): void;
  setSessionError(sessionId: string, error: DaemonApiError): void;
  setSessionStatus(sessionId: string, status: ShellSessionSummary["status"]): void;
  removeSession(sessionId: string): void;
  reset(): void;
}

export type SessionStore = SessionStoreState & SessionStoreActions;

const initialSessionState: SessionStoreState = {
  selectedSessionId: undefined,
  sessions: {},
  sessionOrder: [],
};

export function createSessionStore(initial: Partial<SessionStoreState> = {}) {
  return createStore<SessionStore>()(
    immer((set) => ({
      ...initialSessionState,
      ...initial,
      setSelectedSession(sessionId) {
        set((state) => {
          state.selectedSessionId = sessionId;
        });
      },
      setSessions(sessions) {
        set((state) => {
          state.sessionOrder = sessions.map((session) => session.id);
          for (const session of sessions) {
            const existing = state.sessions[session.id];
            state.sessions[session.id] = {
              loadState: existing?.loadState ?? "idle",
              summary: session,
              bootstrap: existing?.bootstrap,
              error: undefined,
            };
          }

          for (const id of Object.keys(state.sessions)) {
            if (!state.sessionOrder.includes(id)) {
              delete state.sessions[id];
            }
          }
        });
      },
      markLoading(sessionId) {
        set((state) => {
          state.sessions[sessionId] = {
            ...state.sessions[sessionId],
            loadState: "loading",
            error: undefined,
          };
        });
      },
      setBootstrap(bootstrap) {
        set((state) => {
          const id = bootstrap.session.id;
          if (!state.sessionOrder.includes(id)) {
            state.sessionOrder.push(id);
          }
          state.sessions[id] = {
            loadState: "ready",
            summary: bootstrap.session,
            bootstrap,
            error: undefined,
          };
        });
      },
      setSessionError(sessionId, error) {
        set((state) => {
          state.sessions[sessionId] = {
            ...state.sessions[sessionId],
            loadState: "error",
            error,
          };
        });
      },
      setSessionStatus(sessionId, status) {
        set((state) => {
          const record = state.sessions[sessionId];
          if (!record) return;
          if (record.summary) record.summary.status = status;
          if (record.bootstrap) record.bootstrap.session.status = status;
        });
      },
      removeSession(sessionId) {
        set((state) => {
          delete state.sessions[sessionId];
          state.sessionOrder = state.sessionOrder.filter((id) => id !== sessionId);
          if (state.selectedSessionId === sessionId) {
            state.selectedSessionId = undefined;
          }
        });
      },
      reset() {
        set((state) => {
          state.selectedSessionId = undefined;
          state.sessions = {};
          state.sessionOrder = [];
        });
      },
    })),
  );
}

export const sessionStore = createSessionStore();

export function useSessionStore<T>(selector: (state: SessionStore) => T): T {
  return useStore(sessionStore, selector);
}
