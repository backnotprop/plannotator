/**
 * File Browser Hook
 *
 * Manages multiple directory file trees for the sidebar Files tab.
 * Each directory gets its own tree, loading, and error state.
 * Vault directories are supported via the isVault flag — they fetch
 * from the Obsidian vault endpoint instead of the generic files endpoint.
 */

import { useState, useCallback } from "react";
import type { VaultNode } from "../types";

export interface DirState {
  path: string;
  name: string;
  tree: VaultNode[];
  isLoading: boolean;
  error: string | null;
  /** When true, fetches via /api/reference/obsidian/files and opens docs via /api/reference/obsidian/doc */
  isVault?: boolean;
}

export interface UseFileBrowserReturn {
  dirs: DirState[];
  expandedFolders: Set<string>;
  toggleFolder: (key: string) => void;
  collapsedDirs: Set<string>;
  toggleCollapse: (dirPath: string) => void;
  fetchTree: (dirPath: string) => void;
  fetchAll: (directories: string[]) => void;
  addVaultDir: (vaultPath: string) => void;
  clearVaultDirs: () => void;
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
      return [...prev, { path: dirPath, name, tree: [], isLoading: true, error: null }];
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
        const vaultDirs = prev.filter((d) => d.isVault);
        const regularDirs = directories.map((path) => ({
          path,
          name: path.split("/").pop() || path,
          tree: [],
          isLoading: false,
          error: null,
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
