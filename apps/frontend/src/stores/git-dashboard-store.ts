import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { PRDetailedListItem } from "../daemon/contracts";
import type { DaemonApiClient } from "../daemon/api/client";
import { daemonApiClient } from "../daemon/api/client";

export interface GitDashboardPR extends PRDetailedListItem {
  projectCwd: string;
  projectName: string;
  repoSlug: string;
}

export interface GitDashboardState {
  prs: GitDashboardPR[];
  loading: boolean;
  error?: string;
  lastFetchedAt: number | null;
}

export interface GitDashboardActions {
  fetchAllPRs(
    projects: Array<{ cwd: string; name: string; parentCwd?: string }>,
    client?: DaemonApiClient,
  ): Promise<void>;
  clear(): void;
}

export type GitDashboardStore = GitDashboardState & GitDashboardActions;

function extractRepoSlug(url: string): string {
  const gh = url.match(/github\.com\/([^/]+\/[^/]+)/);
  if (gh) return gh[1];
  const gl = url.match(/gitlab\.[^/]+\/(.+?)\/-\//);
  if (gl) return gl[1];
  return "";
}

const initialState: GitDashboardState = {
  prs: [],
  loading: false,
  lastFetchedAt: null,
};

export const gitDashboardStore = createStore<GitDashboardStore>()(
  immer((set) => ({
    ...initialState,

    async fetchAllPRs(projects, client = daemonApiClient) {
      const topLevel = projects.filter((p) => !p.parentCwd);
      if (topLevel.length === 0) return;

      set((state) => {
        state.loading = true;
        state.error = undefined;
      });

      const results = await Promise.allSettled(
        topLevel.map(async (project) => {
          const result = await client.listDetailedPRs(project.cwd);
          return { project, result };
        }),
      );

      const allPRs: GitDashboardPR[] = [];

      for (const outcome of results) {
        if (outcome.status === "rejected") continue;
        const { project, result } = outcome.value;
        if (!result.ok || result.data.prs.length === 0) continue;
        for (const pr of result.data.prs) {
          allPRs.push({
            ...pr,
            projectCwd: project.cwd,
            projectName: project.name,
            repoSlug: extractRepoSlug(pr.url),
          });
        }
      }

      const seen = new Set<string>();
      const deduplicated = allPRs.filter((pr) => {
        if (seen.has(pr.url)) return false;
        seen.add(pr.url);
        return true;
      });

      deduplicated.sort((a, b) => {
        if (a.updatedAt && b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
        return b.number - a.number;
      });

      set((state) => {
        state.prs = deduplicated;
        state.loading = false;
        state.lastFetchedAt = Date.now();
      });
    },

    clear() {
      set((state) => {
        state.prs = [];
        state.lastFetchedAt = null;
        state.error = undefined;
      });
    },
  })),
);

export function useGitDashboardStore<T>(selector: (state: GitDashboardStore) => T): T {
  return useStore(gitDashboardStore, selector);
}
