/**
 * FileBrowser — Markdown file tree for the sidebar
 *
 * Displays collapsible trees of markdown files from user-configured directories.
 * Clicking a file opens it in the main viewer for annotation.
 */

import React from "react";
import type { VaultNode } from "../../types";
import type { DirState } from "../../hooks/useFileBrowser";
import { CountBadge } from "./CountBadge";
import { ObsidianIconRaw } from "../icons/ObsidianIcons";

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
}> = ({ node, depth, dirPath, expandedFolders, onToggleFolder, onSelectFile, activeFile, annotationCounts, highlightedFiles }) => {
  const folderKey = `${dirPath}:${node.path}`;
  const absolutePath = `${dirPath}/${node.path}`;
  const isExpanded = expandedFolders.has(folderKey);
  const isActive = node.type === "file" && absolutePath === activeFile;
  const paddingLeft = 8 + depth * 14;

  if (node.type === "folder") {
    const aggregateCount = annotationCounts ? getAggregateCount(node, dirPath, annotationCounts) : 0;
    return (
      <>
        <button
          onClick={() => onToggleFolder(folderKey)}
          className="w-full flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-sm"
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
          {aggregateCount > 0 && <CountBadge count={aggregateCount} className="ml-auto" />}
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
          />
        ))}
      </>
    );
  }

  const displayName = node.name.replace(/\.mdx?$/i, "");
  const fileCount = annotationCounts?.get(absolutePath) ?? 0;
  const isHighlighted = highlightedFiles?.has(absolutePath);
  return (
    <button
      onClick={() => onSelectFile(absolutePath, dirPath)}
      className={`w-full flex items-center gap-1.5 py-1 text-[11px] transition-colors rounded-sm ${
        isActive
          ? "bg-primary/10 text-primary font-medium"
          : "text-foreground/80 hover:text-foreground hover:bg-muted/50"
      } ${isHighlighted ? 'file-annotation-flash' : ''}`}
      style={{ paddingLeft: paddingLeft + 15 }}
      title={node.path}
    >
      <svg className="w-3 h-3 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <span className="truncate">{displayName}</span>
      {fileCount > 0 && <CountBadge count={fileCount} active={isActive} className="ml-auto" />}
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
}> = ({ dir, expandedFolders, onToggleFolder, onSelectFile, activeFile, onRetry, annotationCounts, highlightedFiles }) => {
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
        No markdown files found
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

  return (
    <div className="flex flex-col">
      {totalCount > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-b border-border/30">
          {totalCount} annotation{totalCount === 1 ? '' : 's'} in {fileCount} file{fileCount === 1 ? '' : 's'}
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
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
