/**
 * FileBrowser — markdown/text file tree for the sidebar
 *
 * Displays collapsible trees of markdown/text files from user-configured directories.
 * Clicking a file opens it in the main viewer for annotation.
 */

import React from "react";
import type { VaultNode } from "../../types";
import type { DirState } from "../../hooks/useFileBrowser";
import { CountBadge } from "./CountBadge";
import { ObsidianIconRaw } from "../icons/ObsidianIcons";
import type { WorkspaceFileChange, WorkspaceStatusPayload } from "@plannotator/shared/workspace-status";

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
  status: "clean" | "dirty" | "saving" | "saved" | "conflict" | "error";
  dirty: boolean;
}

interface AggregateWorkspaceChange {
  additions: number;
  deletions: number;
  files: number;
}

export function normalizePathForLookup(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const prefix = normalized.startsWith("//") ? "//" : "";
  return prefix + normalized.slice(prefix.length).replace(/\/+/g, "/").replace(/\/+$/, "");
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
  counts: Map<string, number>
): number {
  if (node.type === "file") {
    return counts.get(`${dirPath}/${node.path}`) ?? 0;
  }
  let total = 0;
  for (const child of node.children ?? []) {
    total += getAggregateCount(child, dirPath, counts);
  }
  return total;
}

export function getWorkspaceChange(
  absolutePath: string,
  workspaceStatus?: WorkspaceStatusPayload
): WorkspaceFileChange | undefined {
  const files = workspaceStatus?.files;
  if (!files) return undefined;
  const normalizedPath = normalizePathForLookup(absolutePath);
  const direct = files[absolutePath] ?? files[normalizedPath];
  if (direct) return direct;
  for (const [path, change] of Object.entries(files)) {
    if (normalizePathForLookup(path) === normalizedPath) return change;
  }
  return undefined;
}

export function getAggregateWorkspaceChange(
  node: VaultNode,
  dirPath: string,
  workspaceStatus?: WorkspaceStatusPayload
): AggregateWorkspaceChange {
  if (node.type === "file") {
    const change = getWorkspaceChange(`${dirPath}/${node.path}`, workspaceStatus);
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
}> = ({ node, depth, dirPath, expandedFolders, onToggleFolder, onSelectFile, activeFile, annotationCounts, highlightedFiles, editStatuses, workspaceStatus }) => {
  const folderKey = `${dirPath}:${node.path}`;
  const absolutePath = `${dirPath}/${node.path}`;
  const isExpanded = expandedFolders.has(folderKey);
  const isActive = node.type === "file" && absolutePath === activeFile;
  const paddingLeft = 8 + depth * 14;

  if (node.type === "folder") {
    const aggregateCount = annotationCounts ? getAggregateCount(node, dirPath, annotationCounts) : 0;
    const aggregateChange = getAggregateWorkspaceChange(node, dirPath, workspaceStatus);
    return (
      <>
        <button
          onClick={() => onToggleFolder(folderKey)}
          className="file-tree-folder w-full flex items-center gap-1.5 py-1 px-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-sm"
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
          />
        ))}
      </>
    );
  }

  const displayName = node.name.replace(/\.(mdx?|txt|html?)$/i, "");
  const fileCount = annotationCounts?.get(absolutePath) ?? 0;
  const isHighlighted = highlightedFiles?.has(absolutePath);
  const editStatus = editStatuses?.get(absolutePath);
  const workspaceChange = getWorkspaceChange(absolutePath, workspaceStatus);
  const isDeleted = workspaceChange?.status === "deleted";
  const editMarker =
    editStatus?.status === "conflict" || editStatus?.status === "error"
      ? { label: "!", className: "bg-destructive/15 text-destructive", title: editStatus.status === "conflict" ? "Save conflict" : "Save failed" }
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
        if (!isDeleted) onSelectFile(absolutePath, dirPath);
      }}
      disabled={isDeleted}
      className={`file-tree-item w-full text-left group ${isActive ? "active" : ""} ${fileCount > 0 ? "has-annotations" : ""} ${isHighlighted ? 'file-annotation-flash' : ''} ${isDeleted ? 'opacity-70 cursor-default' : ''}`}
      style={{ paddingLeft: paddingLeft + 15 }}
      title={isDeleted ? `${node.path} (deleted on disk)` : node.path}
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
}> = ({ dir, expandedFolders, onToggleFolder, onSelectFile, activeFile, onRetry, annotationCounts, highlightedFiles, editStatuses }) => {
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
        No markdown or text files found
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
      {dirs.map((dir) => {
        const isCollapsed = collapsedDirs.has(dir.path);
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
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
