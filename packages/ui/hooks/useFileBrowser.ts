/**
 * File Browser Hook
 *
 * Manages multiple file-browser sources for the sidebar Files tab.
 * Each source gets its own tree, loading, and error state.
 */

import { useState, useCallback } from "react";
import type { VaultNode } from "../types";
import type { RoamSettings } from "../utils/roam";

export type DirSource = "files" | "obsidian" | "roam";

export interface DirState {
  path: string;
  name: string;
  tree: VaultNode[];
  isLoading: boolean;
  error: string | null;
  source: DirSource;
  roamMeta?: {
    graphName: string;
    graphType: "hosted" | "offline";
    token: string;
    port: number;
  };
}

export interface UseFileBrowserReturn {
  dirs: DirState[];
  expandedFolders: Set<string>;
  toggleFolder: (key: string) => void;
  collapsedDirs: Set<string>;
  toggleCollapse: (dirPath: string) => void;
  fetchTree: (dirPath: string) => void;
  fetchAll: (directories: string[]) => void;
  addObsidianDir: (vaultPath: string) => void;
  addRoamDir: (settings: RoamSettings) => void;
  clearSource: (source: DirSource) => void;
  activeFile: string | null;
  activeDirPath: string | null;
  setActiveFile: (path: string | null) => void;
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

  const fetchTree = useCallback(async (dirPath: string) => {
    const name = dirPath.split("/").pop() || dirPath;

    setDirs((prev) => {
      const exists = prev.find((d) => d.path === dirPath);
      if (exists) {
        return prev.map((d) =>
          d.path === dirPath ? { ...d, isLoading: true, error: null } : d
        );
      }
      return [
        ...prev,
        {
          path: dirPath,
          name,
          tree: [],
          isLoading: true,
          error: null,
          source: "files",
        },
      ];
    });

    try {
      const res = await fetch(
        `/api/reference/files?dirPath=${encodeURIComponent(dirPath)}`
      );
      const data = await res.json();

      if (!res.ok || data.error) {
        setDirs((prev) =>
          prev.map((d) =>
            d.path === dirPath ? { ...d, isLoading: false, error: data.error || "Failed to load" } : d
          )
        );
        return;
      }

      setDirs((prev) =>
        prev.map((d) =>
          d.path === dirPath ? { ...d, tree: data.tree, isLoading: false, error: null } : d
        )
      );

      const rootFolders = (data.tree as VaultNode[])
        .filter((n) => n.type === "folder")
        .map((n) => `${dirPath}:${n.path}`);
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        rootFolders.forEach((f) => next.add(f));
        return next;
      });
    } catch {
      setDirs((prev) =>
        prev.map((d) =>
          d.path === dirPath ? { ...d, isLoading: false, error: "Failed to connect to server" } : d
        )
      );
    }
  }, []);

  const fetchAll = useCallback(
    (directories: string[]) => {
      setDirs((prev) => {
        // Preserve any vault dirs that were already loaded
        const nonFileDirs = prev.filter((d) => d.source !== "files");
        const regularDirs = directories.map((path) => ({
          path,
          name: path.split("/").pop() || path,
          tree: [],
          isLoading: false,
          error: null,
          source: "files" as const,
        }));
        return [...regularDirs, ...nonFileDirs];
      });
      directories.forEach((d) => fetchTree(d));
    },
    [fetchTree]
  );

  const clearSource = useCallback((source: DirSource) => {
    setDirs((prev) => prev.filter((d) => d.source !== source));
  }, []);

  const addObsidianDir = useCallback(async (vaultPath: string) => {
    const name = vaultPath.split("/").pop() || vaultPath;

    // Atomically replace any existing Obsidian dirs (handles vault path change without accumulating stale entries)
    setDirs((prev) => {
      const otherDirs = prev.filter((d) => d.source !== "obsidian");
      return [
        ...otherDirs,
        {
          path: vaultPath,
          name,
          tree: [],
          isLoading: true,
          error: null,
          source: "obsidian",
        },
      ];
    });

    try {
      const res = await fetch(
        `/api/reference/obsidian/files?vaultPath=${encodeURIComponent(vaultPath)}`
      );
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
          d.path === vaultPath
            ? { ...d, tree: data.tree, isLoading: false, source: "obsidian" }
            : d
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

  const addRoamDir = useCallback(async (settings: RoamSettings) => {
    const key = `roam:${settings.graphType}:${settings.graphName}`;

    setDirs((prev) => {
      const otherDirs = prev.filter((d) => d.source !== "roam");
      return [
        ...otherDirs,
        {
          path: key,
          name: settings.graphName,
          tree: [],
          isLoading: true,
          error: null,
          source: "roam",
          roamMeta: {
            graphName: settings.graphName,
            graphType: settings.graphType,
            token: settings.token,
            port: settings.port || 3333,
          },
        },
      ];
    });

    try {
      const res = await fetch(
        `/api/reference/roam/pages?graphName=${encodeURIComponent(settings.graphName)}&graphType=${encodeURIComponent(settings.graphType)}&port=${encodeURIComponent(String(settings.port || 3333))}`,
        {
          headers: {
            Authorization: `Bearer ${settings.token}`,
          },
        },
      );
      const data = await res.json();

      if (!res.ok || data.error) {
        setDirs((prev) =>
          prev.map((d) =>
            d.path === key
              ? { ...d, isLoading: false, error: data.error || "Failed to load" }
              : d,
          ),
        );
        return;
      }

      setDirs((prev) =>
        prev.map((d) =>
          d.path === key
            ? {
                ...d,
                tree: data.tree,
                isLoading: false,
                error: null,
                source: "roam",
                roamMeta: {
                  graphName: settings.graphName,
                  graphType: settings.graphType,
                  token: settings.token,
                  port: settings.port || 3333,
                },
              }
            : d,
        ),
      );
    } catch {
      setDirs((prev) =>
        prev.map((d) =>
          d.path === key
            ? { ...d, isLoading: false, error: "Failed to connect to server" }
            : d,
        ),
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

  return {
    dirs,
    expandedFolders,
    toggleFolder,
    collapsedDirs,
    toggleCollapse,
    fetchTree,
    fetchAll,
    addObsidianDir,
    addRoamDir,
    clearSource,
    activeFile,
    activeDirPath: activeFile ? (dirs.find((d) => activeFile.startsWith(d.path + "/"))?.path ?? null) : null,
    setActiveFile,
  };
}
