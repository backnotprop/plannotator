import React from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { FileTreeNode as TreeNode } from '../utils/buildFileTree';

interface FileTreeNodeProps {
  node: TreeNode;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  activeFileIndex: number;
  onSelectFile: (index: number) => void;
  onDoubleClickFile?: (index: number) => void;
  viewedFiles: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  hideViewedFiles: boolean;
  getAnnotationCount: (filePath: string) => number;
  stagedFiles?: Set<string>;
  scrollHighlightIndex?: number;
  /** Absolute repo root used to build the "Copy full path" menu item. Null in PR-review mode (files aren't on local disk). */
  repoRoot?: string | null;
}

function hasVisibleChildren(
  node: TreeNode,
  viewedFiles: Set<string>,
  activeFileIndex: number,
  hideViewedFiles: boolean,
): boolean {
  if (!hideViewedFiles) return true;
  if (!node.children) return false;

  return node.children.some(child => {
    if (child.type === 'file') {
      return child.fileIndex === activeFileIndex || !viewedFiles.has(child.path);
    }
    return hasVisibleChildren(child, viewedFiles, activeFileIndex, hideViewedFiles);
  });
}

export const FileTreeNodeItem: React.FC<FileTreeNodeProps> = ({
  node,
  expandedFolders,
  onToggleFolder,
  activeFileIndex,
  onSelectFile,
  onDoubleClickFile,
  viewedFiles,
  onToggleViewed,
  hideViewedFiles,
  getAnnotationCount,
  stagedFiles,
  scrollHighlightIndex,
  repoRoot,
}) => {
  const paddingLeft = 4 + node.depth * 8;

  if (node.type === 'folder') {
    if (!hasVisibleChildren(node, viewedFiles, activeFileIndex, hideViewedFiles)) {
      return null;
    }

    const isExpanded = expandedFolders.has(node.path);

    return (
      <>
        <button
          onClick={() => onToggleFolder(node.path)}
          className="w-full flex items-center gap-1.5 py-1 px-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-sm"
          style={{ paddingLeft }}
        >
          <svg
            className={`w-3 h-3 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="truncate">{node.name}</span>
          {(node.additions > 0 || node.deletions > 0) && (
            <div className="flex items-center gap-1.5 ml-auto flex-shrink-0 text-[10px]">
              <span className="additions">+{node.additions}</span>
              <span className="deletions">-{node.deletions}</span>
            </div>
          )}
        </button>
        {isExpanded && node.children?.map(child => (
          <FileTreeNodeItem
            key={child.type === 'file' ? child.path : `folder:${child.path}`}
            node={child}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            activeFileIndex={activeFileIndex}
            onSelectFile={onSelectFile}
            onDoubleClickFile={onDoubleClickFile}
            viewedFiles={viewedFiles}
            onToggleViewed={onToggleViewed}
            hideViewedFiles={hideViewedFiles}
            getAnnotationCount={getAnnotationCount}
            stagedFiles={stagedFiles}
            scrollHighlightIndex={scrollHighlightIndex}
            repoRoot={repoRoot}
          />
        ))}
      </>
    );
  }

  // File node
  const isActive = node.fileIndex === activeFileIndex;
  const isScrollActive = !isActive && scrollHighlightIndex != null && node.fileIndex === scrollHighlightIndex;
  const isViewed = viewedFiles.has(node.path);
  const isStaged = stagedFiles?.has(node.path) ?? false;
  const annotationCount = getAnnotationCount(node.path);

  if (hideViewedFiles && isViewed && !isActive) {
    return null;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          onClick={() => onSelectFile(node.fileIndex!)}
          onDoubleClick={() => onDoubleClickFile?.(node.fileIndex!)}
          className={`file-tree-item w-full text-left group ${isActive ? 'active' : isScrollActive ? 'scroll-active' : ''} ${annotationCount > 0 ? 'has-annotations' : ''} ${isStaged ? 'staged' : ''}`}
          style={{ paddingLeft }}
        >
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <span
              role="checkbox"
              aria-checked={isViewed}
              onClick={(e) => {
                e.stopPropagation();
                onToggleViewed?.(node.path);
              }}
              className="flex-shrink-0 p-0.5 rounded hover:bg-muted/50 cursor-pointer"
            >
              {isViewed ? (
                <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5 text-muted-foreground opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
            </span>
            <span className="truncate">{node.name}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px]">
            {isStaged && (
              <span className="text-primary font-medium" title="Staged (git add)">+</span>
            )}
            {annotationCount > 0 && (
              <span className="text-primary font-medium">{annotationCount}</span>
            )}
            <span className="additions">+{node.file!.additions}</span>
            <span className="deletions">-{node.file!.deletions}</span>
          </div>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-[160px] bg-popover text-popover-foreground border border-border rounded shadow-lg overflow-hidden py-1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
          <ContextMenu.Item
            onSelect={() => navigator.clipboard.writeText(node.path)}
            className="flex items-center gap-2 mx-1 px-2 py-1.5 text-xs rounded cursor-pointer outline-none text-foreground/80 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
          >
            Copy path
          </ContextMenu.Item>
          <ContextMenu.Item
            onSelect={() => navigator.clipboard.writeText(node.name)}
            className="flex items-center gap-2 mx-1 px-2 py-1.5 text-xs rounded cursor-pointer outline-none text-foreground/80 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
          >
            Copy filename
          </ContextMenu.Item>
          {repoRoot && (
            <ContextMenu.Item
              onSelect={() => navigator.clipboard.writeText(`${repoRoot.replace(/\/$/, '')}/${node.path}`)}
              className="flex items-center gap-2 mx-1 px-2 py-1.5 text-xs rounded cursor-pointer outline-none text-foreground/80 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
            >
              Copy full path
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
};
