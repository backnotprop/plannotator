import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ProjectEntry } from "../daemon/contracts";
import type { DaemonApiClient } from "../daemon/api/client";
import { daemonApiClient } from "../daemon/api/client";

export interface ProjectStoreState {
  projects: ProjectEntry[];
  loading: boolean;
  error?: string;
}

export interface ProjectStoreActions {
  fetchProjects(client?: DaemonApiClient): Promise<void>;
  addProject(
    cwd: string,
    name?: string,
    client?: DaemonApiClient,
  ): Promise<ProjectEntry | undefined>;
  removeProject(cwd: string, clean?: boolean, client?: DaemonApiClient): Promise<boolean>;
}

export type ProjectStore = ProjectStoreState & ProjectStoreActions;

const initialState: ProjectStoreState = {
  projects: [],
  loading: false,
};

export function createProjectStore(initial: Partial<ProjectStoreState> = {}) {
  return createStore<ProjectStore>()(
    immer((set) => ({
      ...initialState,
      ...initial,

      async fetchProjects(client = daemonApiClient) {
        set((state) => {
          state.loading = true;
          state.error = undefined;
        });
        const result = await client.listProjects();
        set((state) => {
          state.loading = false;
          if (result.ok) {
            state.projects = result.data.projects;
          } else {
            state.error = result.error.message;
          }
        });
      },

      async addProject(cwd, name, client = daemonApiClient) {
        const result = await client.addProject(cwd, name);
        if (!result.ok) {
          set((state) => {
            state.error = result.error.message;
          });
          return undefined;
        }
        const entry = result.data.project;
        if (entry.parentCwd) {
          const listResult = await client.listProjects();
          if (listResult.ok) {
            set((state) => {
              state.projects = listResult.data.projects;
            });
          }
        } else {
          set((state) => {
            const idx = state.projects.findIndex((p) => p.cwd === entry.cwd);
            if (idx >= 0) {
              state.projects[idx] = entry;
            } else {
              state.projects.unshift(entry);
            }
          });
        }
        return entry;
      },

      async removeProject(cwd, clean, client = daemonApiClient) {
        const result = await client.removeProject(cwd, clean);
        if (!result.ok) {
          set((state) => {
            state.error = result.error.message;
          });
          return false;
        }
        set((state) => {
          state.projects = state.projects.filter((p) => p.cwd !== cwd && p.parentCwd !== cwd);
        });
        return true;
      },
    })),
  );
}

export const projectStore = createProjectStore();

export function useProjectStore<T>(selector: (state: ProjectStore) => T): T {
  return useStore(projectStore, selector);
}
