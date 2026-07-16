/**
 * File Browser Hook
 *
 * Manages multiple directory file trees for the sidebar Files tab.
 * Each directory gets its own tree, loading, and error state.
 * Vault directories are supported via the isVault flag — they fetch
 * from the Obsidian vault endpoint instead of the generic files endpoint.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { VaultNode } from "../types";
import type { WorkspaceStatusPayload } from "@plannotator/core/workspace-status-types";

export interface DirState {
  path: string;
  name: string;
  tree: VaultNode[];
  isLoading: boolean;
  error: string | null;
  workspaceStatus?: WorkspaceStatusPayload;
  /** True after the first successful snapshot; live watching waits for this so watcher setup cannot block initial load. */
  hasLoadedTree?: boolean;
  /** When true, fetches via /api/reference/obsidian/files and opens docs via /api/reference/obsidian/doc */
  isVault?: boolean;
}

export interface UseFileBrowserReturn {
  dirs: DirState[];
  expandedFolders: Set<string>;
  toggleFolder: (key: string) => void;
  collapsedDirs: Set<string>;
  toggleCollapse: (dirPath: string) => void;
  fetchTree: (dirPath: string, options?: { quiet?: boolean }) => void;
  fetchAll: (directories: string[]) => void;
  addVaultDir: (vaultPath: string) => void;
  clearVaultDirs: () => void;
  activeFile: string | null;
  activeDirPath: string | null;
  setActiveFile: (path: string | null) => void;
}

function isPermanentFileBrowserFetchError(status: number): boolean {
  return status >= 400 && status < 500;
}

function normalizeRoot(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function remapWorkspaceStatusForDir(
  status: WorkspaceStatusPayload | undefined,
  dirPath: string
): WorkspaceStatusPayload | undefined {
  if (!status?.rootPath) return status;
  const fromRoot = normalizeRoot(status.rootPath);
  const toRoot = normalizeRoot(dirPath);
  if (!fromRoot) return status;

  const files: WorkspaceStatusPayload["files"] = {};
  for (const [path, change] of Object.entries(status.files)) {
    const normalizedPath = normalizeRoot(path);
    const nextPath = normalizedPath === fromRoot
      ? toRoot
      : normalizedPath.startsWith(`${fromRoot}/`)
        ? `${toRoot}${normalizedPath.slice(fromRoot.length)}`
        : normalizedPath;
    const normalizedOldPath = change.oldPath ? normalizeRoot(change.oldPath) : undefined;
    const nextOldPath = normalizedOldPath && normalizedOldPath.startsWith(`${fromRoot}/`)
      ? `${toRoot}${normalizedOldPath.slice(fromRoot.length)}`
      : normalizedOldPath;
    files[nextPath] = {
      ...change,
      path: nextPath,
      oldPath: nextOldPath,
    };
  }

  return {
    ...status,
    rootPath: dirPath,
    files,
  };
}

/**
 * File-tree backend. Defaults to Plannotator's HTTP endpoints (generic files,
 * Obsidian vault, and the SSE live-watch stream) so Plannotator is unchanged. A
 * host (e.g. Workspaces) calls setFileTreeBackend once at startup to source the
 * tree from its own transport instead.
 */
export interface FileTreeBackend {
  /** Load a directory tree. Resolves to the same shape the /api/reference/files endpoint returns: a Response whose JSON is { tree, workspaceStatus?, error? }. */
  loadTree(dirPath: string): Promise<Response>;
  /** Load an Obsidian vault tree. Resolves to a Response whose JSON is { tree, error? }. */
  loadVaultTree(vaultPath: string): Promise<Response>;
  /**
   * Begin live-watching the given directory paths. `onChange(path)` is invoked
   * (already debounced/deduped) whenever a watched tree should be re-fetched.
   * Returns a cleanup function. Returning undefined means no watcher started.
   */
  watchTrees(paths: string[], onChange: (path: string) => void): (() => void) | undefined;
}

const defaultFileTreeBackend: FileTreeBackend = {
  loadTree(dirPath) {
    return fetch(`/api/reference/files?dirPath=${encodeURIComponent(dirPath)}`);
  },
  loadVaultTree(vaultPath) {
    return fetch(`/api/reference/obsidian/files?vaultPath=${encodeURIComponent(vaultPath)}`);
  },
  watchTrees(paths, onChange) {
    if (typeof EventSource === "undefined") return undefined;

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const readyPaths = new Set<string>();
    const params = new URLSearchParams();
    for (const path of paths) params.append("dirPath", path);
    const source = new EventSource(`/api/reference/files/stream?${params.toString()}`);
    const scheduleFetch = (path: string) => {
      const existing = timers.get(path);
      if (existing) clearTimeout(existing);
      timers.set(path, setTimeout(() => {
        timers.delete(path);
        onChange(path);
      }, 120));
    };
    const scheduleEventFetch = (dirPath: unknown) => {
      if (typeof dirPath === "string" && paths.includes(dirPath)) {
        scheduleFetch(dirPath);
        return;
      }
      for (const path of paths) scheduleFetch(path);
    };
    const hasSeenReady = (dirPath: unknown): boolean => {
      if (typeof dirPath === "string" && paths.includes(dirPath)) {
        if (readyPaths.has(dirPath)) return true;
        readyPaths.add(dirPath);
        return false;
      }

      const hadAll = paths.every((path) => readyPaths.has(path));
      for (const path of paths) readyPaths.add(path);
      return hadAll;
    };
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; dirPath?: string };
        if (data.type === "ready") {
          if (hasSeenReady(data.dirPath)) scheduleEventFetch(data.dirPath);
          return;
        }
        if (data.type !== "changed") return;
        scheduleEventFetch(data.dirPath);
      } catch {
        return;
      }
    };

    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      source.close();
    };
  },
};

// Active backend. Defaults to Plannotator's HTTP endpoints so Plannotator is
// unchanged. A host calls setFileTreeBackend once at startup to override.
let fileTreeBackend: FileTreeBackend = defaultFileTreeBackend;

/** Override the file-tree backend. Call once at app startup. */
export function setFileTreeBackend(b: FileTreeBackend): void {
  fileTreeBackend = b;
}

/** Reset to the default (HTTP endpoint) backend. Mainly for tests. */
export function resetFileTreeBackend(): void {
  fileTreeBackend = defaultFileTreeBackend;
}

export function useFileBrowser(): UseFileBrowserReturn {
  const [dirs, setDirs] = useState<DirState[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const toggleCollapse = useCallback((dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const fetchTree = useCallback(async (dirPath: string, options: { quiet?: boolean } = {}) => {
    const name = dirPath.split("/").pop() || dirPath;

    setDirs((prev) => {
      const exists = prev.find((d) => d.path === dirPath);
      if (exists) {
        return prev.map((d) =>
          d.path === dirPath
            ? { ...d, isLoading: options.quiet ? d.isLoading : true, error: options.quiet ? d.error : null }
            : d
        );
      }
      return [...prev, { path: dirPath, name, tree: [], isLoading: true, error: null, hasLoadedTree: false }];
    });

    try {
      const res = await fileTreeBackend.loadTree(dirPath);
      const data = await res.json();

      if (!res.ok || data.error) {
        const error = data.error || "Failed to load";
        const shouldSurfaceError = !options.quiet || isPermanentFileBrowserFetchError(res.status);
        setDirs((prev) =>
          prev.map((d) =>
            d.path === dirPath
              ? shouldSurfaceError
                ? {
                  ...d,
                  tree: options.quiet ? [] : d.tree,
                  workspaceStatus: options.quiet ? undefined : d.workspaceStatus,
                  isLoading: false,
                  hasLoadedTree: false,
                  error,
                }
                : { ...d, isLoading: false, error: d.error }
              : d
          )
        );
        return;
      }

      const workspaceStatus = remapWorkspaceStatusForDir(data.workspaceStatus, dirPath);
      setDirs((prev) =>
        prev.map((d) =>
          d.path === dirPath
            ? {
              ...d,
              tree: data.tree,
              workspaceStatus,
              isLoading: false,
              hasLoadedTree: true,
              error: null,
            }
            : d
        )
      );

      if (!options.quiet) {
        const rootFolders = (data.tree as VaultNode[])
          .filter((n) => n.type === "folder")
          .map((n) => `${dirPath}:${n.path}`);
        setExpandedFolders((prev) => {
          const next = new Set(prev);
          rootFolders.forEach((f) => next.add(f));
          return next;
        });
      }
    } catch {
      setDirs((prev) =>
        prev.map((d) =>
          d.path === dirPath
            ? { ...d, isLoading: false, error: options.quiet ? d.error : "Failed to connect to server" }
            : d
        )
      );
    }
  }, []);

  const fetchTreeRef = useRef(fetchTree);
  useEffect(() => {
    fetchTreeRef.current = fetchTree;
  }, [fetchTree]);

  const fetchAll = useCallback(
    (directories: string[]) => {
      setDirs((prev) => {
        // Preserve any vault dirs that were already loaded
        const vaultDirs = prev.filter((d) => d.isVault);
        const regularDirs = directories.map((path) => ({
          path,
          name: path.split("/").pop() || path,
          tree: [],
          // Keep initial roots loading until their first snapshot resolves. If
          // the SSE watcher starts before /api/reference/files finishes,
          // chokidar setup on large repo roots can block the server long enough
          // that the visible tree sits on "Loading..." for seconds.
          isLoading: true,
          error: null,
          hasLoadedTree: false,
        }));
        return [...regularDirs, ...vaultDirs];
      });
      directories.forEach((d) => fetchTree(d));
    },
    [fetchTree]
  );

  const clearVaultDirs = useCallback(() => {
    setDirs((prev) => prev.filter((d) => !d.isVault));
  }, []);

  const addVaultDir = useCallback(async (vaultPath: string) => {
    const name = vaultPath.split("/").pop() || vaultPath;

    // Atomically replace any existing vault dirs (handles vault path change without accumulating stale entries)
    setDirs((prev) => {
      const nonVaultDirs = prev.filter((d) => !d.isVault);
      return [...nonVaultDirs, { path: vaultPath, name, tree: [], isLoading: true, error: null, isVault: true }];
    });

    try {
      const res = await fileTreeBackend.loadVaultTree(vaultPath);
      const data = await res.json();

      if (!res.ok || data.error) {
        setDirs((prev) =>
          prev.map((d) =>
            d.path === vaultPath ? { ...d, isLoading: false, error: data.error || "Failed to load" } : d
          )
        );
        return;
      }

      setDirs((prev) =>
        prev.map((d) =>
          d.path === vaultPath ? { ...d, tree: data.tree, isLoading: false, isVault: true } : d
        )
      );

      const rootFolders = (data.tree as VaultNode[])
        .filter((n) => n.type === "folder")
        .map((n) => `${vaultPath}:${n.path}`);
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        rootFolders.forEach((f) => next.add(f));
        return next;
      });
    } catch {
      setDirs((prev) =>
        prev.map((d) =>
          d.path === vaultPath ? { ...d, isLoading: false, error: "Failed to connect to server" } : d
        )
      );
    }
  }, []);

  const toggleFolder = useCallback((key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const watchDirsKey = useMemo(
    () => {
      const regularDirs = dirs.filter((dir) => !dir.isVault);
      const initialLoadPending = regularDirs.some((dir) => dir.isLoading && !dir.hasLoadedTree);
      if (initialLoadPending) return "";

      return regularDirs
        // Subscribe only after the initial snapshot is visible. Live updates are
        // for future freshness; they must not compete with first paint.
        .filter((dir) => !dir.error && dir.hasLoadedTree)
        .map((dir) => dir.path)
        .sort()
        .join("\n");
    },
    [dirs]
  );

  useEffect(() => {
    if (!watchDirsKey) return;
    const paths = watchDirsKey.split("\n").filter(Boolean);
    return fileTreeBackend.watchTrees(paths, (path) => {
      fetchTreeRef.current(path, { quiet: true });
    });
  }, [watchDirsKey]);

  return {
    dirs,
    expandedFolders,
    toggleFolder,
    collapsedDirs,
    toggleCollapse,
    fetchTree,
    fetchAll,
    addVaultDir,
    clearVaultDirs,
    activeFile,
    activeDirPath: activeFile ? (dirs.find((d) => activeFile.startsWith(d.path + "/"))?.path ?? null) : null,
    setActiveFile,
  };
}
