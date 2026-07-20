/**
 * FileBrowser — markdown/text file tree for the sidebar
 *
 * Displays collapsible trees of markdown/text files from user-configured directories.
 * Clicking a file opens it in the main viewer for annotation.
 */

import React from "react";
import { Search, X } from "lucide-react";
import type { VaultNode } from "../../types";
import type { DirState } from "../../hooks/useFileBrowser";
import { CountBadge } from "./CountBadge";
import { ObsidianIconRaw } from "../icons/ObsidianIcons";
import type { WorkspaceFileChange, WorkspaceStatusPayload } from "@plannotator/core/workspace-status-types";
import { normalizeBrowserPath } from "@plannotator/core/browser-paths";

interface FileBrowserProps {
  dirs: DirState[];
  expandedFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  collapsedDirs: Set<string>;
  onToggleCollapse: (dirPath: string) => void;
  onSelectFile: (absolutePath: string, dirPath: string) => void;
  activeFile: string | null;
  onFetchAll: () => void;
  onRetryVaultDir?: (vaultPath: string) => void;
  annotationCounts?: Map<string, number>;
  highlightedFiles?: Set<string>;
  editStatuses?: Map<string, FileEditStatus>;
}

export interface FileEditStatus {
  key?: string;
  path?: string;
  status: "clean" | "dirty" | "saving" | "saved" | "conflict" | "error" | "missing";
  dirty: boolean;
  conflict?: boolean;
}

interface AggregateWorkspaceChange {
  additions: number;
  deletions: number;
  files: number;
}

// Display-name stripping only — deliberately narrower than the annotatable
// set. Config files (config.yaml vs config.json) keep their extensions so
// same-named siblings stay distinguishable in the tree.
const FILE_EXTENSION_RE = /\.(mdx?|txt|html?)$/i;

function normalizeFilterText(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

export function getFileTreeFilterTokens(query: string): string[] {
  return normalizeFilterText(query)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function nodeMatchesFilter(node: VaultNode, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const displayName = node.name.replace(FILE_EXTENSION_RE, "");
  const haystack = normalizeFilterText(`${node.name} ${displayName} ${node.path}`);
  return tokens.every((token) => haystack.includes(token));
}

export function filterFileTree(nodes: VaultNode[], tokens: string[]): VaultNode[] {
  if (tokens.length === 0) return nodes;

  return nodes.flatMap((node) => {
    if (node.type === "file") return nodeMatchesFilter(node, tokens) ? [node] : [];

    if (nodeMatchesFilter(node, tokens)) return [node];

    const children = filterFileTree(node.children ?? [], tokens);
    if (children.length === 0) return [];
    return [{ ...node, children }];
  });
}

export function normalizePathForLookup(path: string): string {
  return normalizeBrowserPath(path);
}

function joinLookupPath(rootPath: string, relativePath: string): string {
  const root = normalizePathForLookup(rootPath);
  const relative = normalizePathForLookup(relativePath).replace(/^\/+/, "");
  if (!relative || relative === ".") return root;
  if (root === "/" || /^[A-Za-z]:\/$/.test(root)) return normalizePathForLookup(`${root}${relative}`);
  return normalizePathForLookup(`${root}/${relative}`);
}

export function getPathLookupCandidates(
  absolutePath: string,
  relativePath?: string,
  workspaceStatus?: WorkspaceStatusPayload,
): string[] {
  const candidates = [absolutePath, normalizePathForLookup(absolutePath)];
  if (relativePath && workspaceStatus?.rootPath) {
    candidates.push(joinLookupPath(workspaceStatus.rootPath, relativePath));
  }
  const seen = new Set<string>();
  return candidates.filter((path) => {
    const normalized = normalizePathForLookup(path);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function getPathMapValue<T>(map: Map<string, T> | undefined, paths: string | string[]): T | undefined {
  if (!map) return undefined;
  const candidates = Array.isArray(paths) ? paths : [paths];
  const normalizedCandidates = candidates.map(normalizePathForLookup);
  for (let index = 0; index < candidates.length; index += 1) {
    const path = candidates[index];
    const normalized = normalizedCandidates[index];
    if (map.has(path)) return map.get(path);
    if (map.has(normalized)) return map.get(normalized);
  }
  for (const [path, value] of map.entries()) {
    if (normalizedCandidates.includes(normalizePathForLookup(path))) return value;
  }
  return undefined;
}

function pathSetHas(paths: Set<string> | undefined, candidates: string | string[]): boolean {
  if (!paths) return false;
  const candidatePaths = Array.isArray(candidates) ? candidates : [candidates];
  const normalizedCandidates = candidatePaths.map(normalizePathForLookup);
  for (let index = 0; index < candidatePaths.length; index += 1) {
    if (paths.has(candidatePaths[index]) || paths.has(normalizedCandidates[index])) return true;
  }
  for (const path of paths) {
    if (normalizedCandidates.includes(normalizePathForLookup(path))) return true;
  }
  return false;
}

export function getFileEditStatus(
  absolutePath: string,
  editStatuses?: Map<string, FileEditStatus>,
  relativePath?: string,
  workspaceStatus?: WorkspaceStatusPayload,
): FileEditStatus | undefined {
  return getPathMapValue(editStatuses, getPathLookupCandidates(absolutePath, relativePath, workspaceStatus));
}

function normalizeWorkspaceStatus(
  workspaceStatus?: WorkspaceStatusPayload
): WorkspaceStatusPayload | undefined {
  if (!workspaceStatus) return workspaceStatus;
  const files: WorkspaceStatusPayload["files"] = {};
  for (const [path, change] of Object.entries(workspaceStatus.files ?? {})) {
    const normalizedPath = normalizePathForLookup(path);
    const normalizedOldPath = change.oldPath ? normalizePathForLookup(change.oldPath) : undefined;
    files[normalizedPath] = {
      ...change,
      path: normalizedPath,
      oldPath: normalizedOldPath,
    };
  }
  return {
    ...workspaceStatus,
    rootPath: normalizePathForLookup(workspaceStatus.rootPath),
    files,
  };
}

/** Recursively sum annotation counts for all descendant files of a folder node */
function getAggregateCount(
  node: VaultNode,
  dirPath: string,
  counts: Map<string, number>,
  workspaceStatus?: WorkspaceStatusPayload,
): number {
  if (node.type === "file") {
    return getPathMapValue(counts, getPathLookupCandidates(`${dirPath}/${node.path}`, node.path, workspaceStatus)) ?? 0;
  }
  let total = 0;
  for (const child of node.children ?? []) {
    total += getAggregateCount(child, dirPath, counts, workspaceStatus);
  }
  return total;
}

export function getWorkspaceChange(
  absolutePath: string,
  workspaceStatus?: WorkspaceStatusPayload,
  relativePath?: string,
): WorkspaceFileChange | undefined {
  const files = workspaceStatus?.files;
  if (!files) return undefined;
  const candidates = getPathLookupCandidates(absolutePath, relativePath, workspaceStatus);
  const normalizedCandidates = candidates.map(normalizePathForLookup);
  for (let index = 0; index < candidates.length; index += 1) {
    const direct = files[candidates[index]] ?? files[normalizedCandidates[index]];
    if (direct) return direct;
  }
  for (const [path, change] of Object.entries(files)) {
    if (normalizedCandidates.includes(normalizePathForLookup(path))) return change;
  }
  return undefined;
}

export function isFileTreeSelectionDisabled(
  workspaceChange: WorkspaceFileChange | undefined,
  editStatus: FileEditStatus | undefined,
): boolean {
  return workspaceChange?.status === "deleted" && editStatus?.status !== "missing";
}

export function getAggregateWorkspaceChange(
  node: VaultNode,
  dirPath: string,
  workspaceStatus?: WorkspaceStatusPayload
): AggregateWorkspaceChange {
  if (node.type === "file") {
    const change = getWorkspaceChange(`${dirPath}/${node.path}`, workspaceStatus, node.path);
    return change
      ? { additions: change.additions, deletions: change.deletions, files: 1 }
      : { additions: 0, deletions: 0, files: 0 };
  }
  return (node.children ?? []).reduce<AggregateWorkspaceChange>((total, child) => {
    const childTotal = getAggregateWorkspaceChange(child, dirPath, workspaceStatus);
    return {
      additions: total.additions + childTotal.additions,
      deletions: total.deletions + childTotal.deletions,
      files: total.files + childTotal.files,
    };
  }, { additions: 0, deletions: 0, files: 0 });
}

const TreeNode: React.FC<{
  node: VaultNode;
  depth: number;
  dirPath: string;
  expandedFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  onSelectFile: (absolutePath: string, dirPath: string) => void;
  activeFile: string | null;
  annotationCounts?: Map<string, number>;
  highlightedFiles?: Set<string>;
  editStatuses?: Map<string, FileEditStatus>;
  workspaceStatus?: WorkspaceStatusPayload;
  forceExpandFolders?: boolean;
}> = ({ node, depth, dirPath, expandedFolders, onToggleFolder, onSelectFile, activeFile, annotationCounts, highlightedFiles, editStatuses, workspaceStatus, forceExpandFolders = false }) => {
  const folderKey = `${dirPath}:${node.path}`;
  const absolutePath = `${dirPath}/${node.path}`;
  const isExpanded = forceExpandFolders || expandedFolders.has(folderKey);
  const isActive = node.type === "file" && absolutePath === activeFile;
  const paddingLeft = 8 + depth * 14;

  if (node.type === "folder") {
    const aggregateCount = annotationCounts ? getAggregateCount(node, dirPath, annotationCounts, workspaceStatus) : 0;
    const aggregateChange = getAggregateWorkspaceChange(node, dirPath, workspaceStatus);
    const folderButtonClassName = forceExpandFolders
      ? "file-tree-folder w-full flex items-center gap-1.5 py-1 px-2 text-[11px] text-muted-foreground transition-colors rounded-sm cursor-default disabled:opacity-100"
      : "file-tree-folder w-full flex items-center gap-1.5 py-1 px-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-sm";
    return (
      <>
        <button
          disabled={forceExpandFolders}
          onClick={() => onToggleFolder(folderKey)}
          className={folderButtonClassName}
          style={{ paddingLeft }}
        >
          <svg
            className={`w-3 h-3 flex-shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <svg className="w-3 h-3 flex-shrink-0 text-muted-foreground/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="truncate">{node.name}</span>
          <div className="ml-auto flex flex-shrink-0 items-center gap-1.5 text-[10px]">
            {(aggregateChange.additions > 0 || aggregateChange.deletions > 0) && (
              <>
                {aggregateChange.additions > 0 && <span className="additions">+{aggregateChange.additions}</span>}
                {aggregateChange.deletions > 0 && <span className="deletions">-{aggregateChange.deletions}</span>}
              </>
            )}
            {aggregateCount > 0 && <CountBadge count={aggregateCount} />}
          </div>
        </button>
        {isExpanded && node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            dirPath={dirPath}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
            activeFile={activeFile}
            annotationCounts={annotationCounts}
            highlightedFiles={highlightedFiles}
            editStatuses={editStatuses}
            workspaceStatus={workspaceStatus}
            forceExpandFolders={forceExpandFolders}
          />
        ))}
      </>
    );
  }

  const displayName = node.name.replace(/\.(mdx?|txt|html?)$/i, "");
  const lookupCandidates = getPathLookupCandidates(absolutePath, node.path, workspaceStatus);
  const fileCount = getPathMapValue(annotationCounts, lookupCandidates) ?? 0;
  const isHighlighted = pathSetHas(highlightedFiles, lookupCandidates);
  const editStatus = getFileEditStatus(absolutePath, editStatuses, node.path, workspaceStatus);
  const workspaceChange = getWorkspaceChange(absolutePath, workspaceStatus, node.path);
  const isDeleted = workspaceChange?.status === "deleted";
  const isSelectionDisabled = isFileTreeSelectionDisabled(workspaceChange, editStatus);
  const editMarker =
    editStatus?.status === "conflict" || editStatus?.status === "error"
      ? { label: "!", className: "bg-destructive/15 text-destructive", title: editStatus.status === "conflict" ? "Save conflict" : "Save failed" }
      : editStatus?.status === "missing"
        ? { label: "!", className: "bg-warning/15 text-warning-foreground", title: "File missing on disk" }
      : editStatus?.status === "saving"
        ? { label: "...", className: "bg-primary/10 text-primary", title: "Saving" }
        : editStatus?.dirty
          ? { label: "•", className: "bg-primary/10 text-primary", title: "Unsaved edits" }
          : editStatus?.status === "saved"
            ? { label: "✓", className: "bg-success/15 text-success", title: "Saved" }
            : null;
  const statusMarker = workspaceChange?.status === "added"
    ? { label: "A", className: "text-success", title: "Added file" }
    : workspaceChange?.status === "untracked"
      ? { label: "U", className: "text-primary", title: "Untracked file" }
      : workspaceChange?.status === "deleted"
        ? { label: "D", className: "text-destructive", title: "Deleted file" }
        : workspaceChange?.status === "renamed"
          ? { label: "R", className: "text-[#007aff]", title: workspaceChange.oldPath ? `Renamed from ${workspaceChange.oldPath}` : "Renamed file" }
          : workspaceChange?.status === "conflicted"
            ? { label: "!", className: "text-destructive", title: "Git conflict" }
            : null;
  return (
    <button
      onClick={() => {
        if (!isSelectionDisabled) onSelectFile(absolutePath, dirPath);
      }}
      disabled={isSelectionDisabled}
      className={`file-tree-item w-full text-left group ${isActive ? "active" : ""} ${fileCount > 0 ? "has-annotations" : ""} ${isHighlighted ? 'file-annotation-flash' : ''} ${isSelectionDisabled ? 'opacity-70 cursor-default' : ''}`}
      style={{ paddingLeft: paddingLeft + 15 }}
      title={isDeleted ? `${node.path} (${editStatus?.status === "missing" ? "missing on disk" : "deleted on disk"})` : node.path}
    >
      <svg className="w-3 h-3 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <span className={`truncate flex-1 min-w-0 ${isDeleted ? "line-through" : ""}`}>{displayName}</span>
      <div className="ml-auto flex flex-shrink-0 items-center gap-1.5 text-[10px]">
        {editMarker && (
          <span
            className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none ${editMarker.className}`}
            title={editMarker.title}
          >
            {editMarker.label}
          </span>
        )}
        {fileCount > 0 && <CountBadge count={fileCount} active={isActive} />}
        {workspaceChange && (
          <>
            {workspaceChange.additions > 0 && <span className="additions">+{workspaceChange.additions}</span>}
            {workspaceChange.deletions > 0 && <span className="deletions">-{workspaceChange.deletions}</span>}
            {statusMarker && (
              <span className={`font-semibold ${statusMarker.className}`} title={statusMarker.title}>
                {statusMarker.label}
              </span>
            )}
          </>
        )}
      </div>
    </button>
  );
};

const DirSection: React.FC<{
  dir: DirState;
  expandedFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  onSelectFile: (absolutePath: string, dirPath: string) => void;
  activeFile: string | null;
  onRetry: () => void;
  annotationCounts?: Map<string, number>;
  highlightedFiles?: Set<string>;
  editStatuses?: Map<string, FileEditStatus>;
  forceExpandFolders?: boolean;
}> = ({ dir, expandedFolders, onToggleFolder, onSelectFile, activeFile, onRetry, annotationCounts, highlightedFiles, editStatuses, forceExpandFolders = false }) => {
  const workspaceStatus = React.useMemo(() => normalizeWorkspaceStatus(dir.workspaceStatus), [dir.workspaceStatus]);

  if (dir.isLoading) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (dir.error) {
    return (
      <div className="p-3 space-y-2">
        <div className="text-[11px] text-destructive">{dir.error}</div>
        <button
          onClick={onRetry}
          className="text-[10px] text-primary hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (dir.tree.length === 0) {
    return (
      <div className="px-3 py-2 text-[11px] text-muted-foreground">
        No annotatable files found
      </div>
    );
  }

  return (
    <div className="py-1 px-1">
      {dir.tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          dirPath={dir.path}
          expandedFolders={expandedFolders}
          onToggleFolder={onToggleFolder}
          onSelectFile={onSelectFile}
          activeFile={activeFile}
          annotationCounts={annotationCounts}
          highlightedFiles={highlightedFiles}
          editStatuses={editStatuses}
          workspaceStatus={workspaceStatus}
          forceExpandFolders={forceExpandFolders}
        />
      ))}
    </div>
  );
};

export const FileBrowser: React.FC<FileBrowserProps> = ({
  dirs,
  expandedFolders,
  onToggleFolder,
  collapsedDirs,
  onToggleCollapse,
  onSelectFile,
  activeFile,
  onFetchAll,
  onRetryVaultDir,
  annotationCounts,
  highlightedFiles,
  editStatuses,
}) => {
  const [isFilterOpen, setIsFilterOpen] = React.useState(false);
  const [filterQuery, setFilterQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const deferredFilterQuery = React.useDeferredValue(filterQuery);
  const filterTokens = React.useMemo(() => getFileTreeFilterTokens(deferredFilterQuery), [deferredFilterQuery]);
  const isFiltering = filterTokens.length > 0;
  const showFilterInput = isFilterOpen || filterQuery.trim().length > 0;
  const visibleDirs = React.useMemo(() => {
    if (!isFiltering) return dirs;
    return dirs
      .map((dir) => ({ ...dir, tree: filterFileTree(dir.tree, filterTokens) }))
      .filter((dir) => dir.isLoading || dir.error || dir.tree.length > 0);
  }, [dirs, filterTokens, isFiltering]);
  const handleFilterBlur = React.useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (filterQuery.trim()) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setIsFilterOpen(false);
  }, [filterQuery]);

  React.useEffect(() => {
    if (!showFilterInput) return;
    inputRef.current?.focus();
  }, [showFilterInput]);

  if (dirs.length === 0) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground">
        No directories configured. Add directories in Settings → Files.
      </div>
    );
  }

  // Summary header
  const totalCount = annotationCounts ? Array.from(annotationCounts.values()).reduce((s, c) => s + c, 0) : 0;
  const fileCount = annotationCounts?.size ?? 0;
  const workspaceTotals = dirs.reduce(
    (total, dir) => {
      if (!dir.workspaceStatus?.available) return total;
      return {
        files: total.files + dir.workspaceStatus.totals.files,
        additions: total.additions + dir.workspaceStatus.totals.additions,
        deletions: total.deletions + dir.workspaceStatus.totals.deletions,
      };
    },
    { files: 0, additions: 0, deletions: 0 }
  );

  return (
    <div className="flex flex-col">
      {totalCount > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-b border-border/30">
          {totalCount} annotation{totalCount === 1 ? '' : 's'} in {fileCount} file{fileCount === 1 ? '' : 's'}
        </div>
      )}
      {workspaceTotals.files > 0 && (
        <div className="file-tree-status-summary flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-muted-foreground border-b border-border/30">
          <span>{workspaceTotals.files} changed</span>
          {workspaceTotals.additions > 0 && <span className="additions ml-auto">+{workspaceTotals.additions}</span>}
          {workspaceTotals.deletions > 0 && <span className={`deletions ${workspaceTotals.additions > 0 ? "" : "ml-auto"}`}>-{workspaceTotals.deletions}</span>}
        </div>
      )}
      <div className="border-b border-border/20 px-2 py-0.5">
        {showFilterInput ? (
          <div
            onBlur={handleFilterBlur}
            className="flex h-6 items-center gap-1.5 rounded-sm bg-muted/25 px-1.5 text-muted-foreground focus-within:bg-muted/40"
          >
            <Search size={12} className="shrink-0 text-muted-foreground/55" aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                if (filterQuery) setFilterQuery("");
                else setIsFilterOpen(false);
              }}
              placeholder="Filter"
              aria-label="Filter files"
              autoComplete="off"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore
              className="file-browser-filter-input h-full min-w-0 flex-1 bg-transparent p-0 text-[16px] leading-4 text-foreground outline-none placeholder:text-muted-foreground/45 sm:text-[11px]"
            />
            {filterQuery && (
              <button
                type="button"
                onClick={() => {
                  setFilterQuery("");
                  inputRef.current?.focus();
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/55 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:bg-muted"
                aria-label="Clear file filter"
                title="Clear file filter"
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsFilterOpen(true)}
            className="flex h-6 w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[10px] text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:bg-muted/50 focus-visible:text-foreground"
            aria-label="Filter files"
            title="Filter files"
          >
            <Search size={12} className="shrink-0 text-muted-foreground/55" aria-hidden="true" />
            <span className="truncate">Filter</span>
          </button>
        )}
      </div>
      {isFiltering && visibleDirs.length === 0 && (
        <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
          No files match "{deferredFilterQuery.trim()}"
        </div>
      )}
      {visibleDirs.map((dir) => {
        const isCollapsed = !isFiltering && collapsedDirs.has(dir.path);
        return (
          <div key={dir.path}>
            <button
              onClick={() => onToggleCollapse(dir.path)}
              className="w-full flex items-center gap-1.5 px-3 py-2 border-b border-border/30 hover:bg-muted/50 transition-colors"
              title={dir.path}
            >
              <svg
                className={`w-3 h-3 flex-shrink-0 text-muted-foreground/60 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              {dir.isVault && <ObsidianIconRaw className="w-[11px] h-[13px] flex-shrink-0 opacity-70" />}
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider truncate">
                {dir.name}
              </div>
            </button>
            {!isCollapsed && (
              <DirSection
                dir={dir}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
                activeFile={activeFile}
                onRetry={dir.isVault && onRetryVaultDir ? () => onRetryVaultDir(dir.path) : onFetchAll}
                annotationCounts={annotationCounts}
                highlightedFiles={highlightedFiles}
                editStatuses={editStatuses}
                forceExpandFolders={isFiltering}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
