import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { immer } from "zustand/middleware/immer";

export type ShellPanel = "sessions" | "details" | "diagnostics";

export interface ShellStoreState {
  activePanel: ShellPanel;
  compactDensity: boolean;
  diagnosticsOpen: boolean;
}

export interface ShellStoreActions {
  setActivePanel(panel: ShellPanel): void;
  setCompactDensity(value: boolean): void;
  toggleDiagnostics(): void;
}

export type ShellStore = ShellStoreState & ShellStoreActions;

const initialShellState: ShellStoreState = {
  activePanel: "sessions",
  compactDensity: false,
  diagnosticsOpen: false,
};

export function createShellStore(initial: Partial<ShellStoreState> = {}) {
  return createStore<ShellStore>()(
    immer((set) => ({
      ...initialShellState,
      ...initial,
      setActivePanel(panel) {
        set((state) => {
          state.activePanel = panel;
        });
      },
      setCompactDensity(value) {
        set((state) => {
          state.compactDensity = value;
        });
      },
      toggleDiagnostics() {
        set((state) => {
          state.diagnosticsOpen = !state.diagnosticsOpen;
        });
      },
    })),
  );
}

export const shellStore = createShellStore();

export function useShellStore<T>(selector: (state: ShellStore) => T): T {
  return useStore(shellStore, selector);
}
