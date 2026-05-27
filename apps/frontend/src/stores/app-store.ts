import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { SessionBootstrap } from "../daemon/contracts";

export interface VisitedSession {
  sessionId: string;
  bootstrap: SessionBootstrap;
}

export interface AppState {
  addProjectOpen: boolean;
  settingsOpen: boolean;
  activeSessionId: string | null;
  visitedSessions: Record<string, VisitedSession>;
}

export interface AppActions {
  setAddProjectOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  activateSession(sessionId: string, bootstrap: SessionBootstrap): void;
  deactivateSession(): void;
  removeSession(sessionId: string): void;
}

export type AppStore = AppState & AppActions;

const initialState: AppState = {
  addProjectOpen: false,
  settingsOpen: false,
  activeSessionId: null,
  visitedSessions: {},
};

export function createAppStore(initial: Partial<AppState> = {}) {
  return createStore<AppStore>()(
    immer((set) => ({
      ...initialState,
      ...initial,
      setAddProjectOpen(open) {
        set((state) => {
          state.addProjectOpen = open;
        });
      },
      setSettingsOpen(open) {
        set((state) => {
          state.settingsOpen = open;
        });
      },
      activateSession(sessionId, bootstrap) {
        set((state) => {
          state.activeSessionId = sessionId;
          if (!state.visitedSessions[sessionId]) {
            state.visitedSessions[sessionId] = { sessionId, bootstrap };
          }
        });
      },
      deactivateSession() {
        set((state) => {
          state.activeSessionId = null;
        });
      },
      removeSession(sessionId) {
        set((state) => {
          delete state.visitedSessions[sessionId];
          if (state.activeSessionId === sessionId) {
            state.activeSessionId = null;
          }
        });
      },
    })),
  );
}

export const appStore = createAppStore();

export function useAppStore<T>(selector: (state: AppStore) => T): T {
  return useStore(appStore, selector);
}
