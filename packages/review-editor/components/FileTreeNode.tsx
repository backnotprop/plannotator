import React from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { FileTreeNode as TreeNode } from '../utils/buildFileTree';
import { ViewedControl, ChangeTypeLetter, StageControl, AnnotationBadge, DiffCounts, CommittedDot } from './FileRowBits';

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
  /** EFFECTIVE staged set from useGitAdd (sidecar + session overrides).
   *  REQUIRED and the ONLY staging source surfaces may render from — the
   *  sidecar's own `staged` flag is a snapshot and must never be ORed in. */
  stagedFiles: Set<string>;
  scrollHighlightIndex?: number;
  /** Absolute repo root used to build the "Copy full path" menu item. Null in PR-review mode (files aren't on local disk). */
  repoRoot?: string | null;
  /** Since-base mode extras: sidecar lookup for untracked (U) / staged (dot)
   * markers and the per-row stage button. Undefined outside since-base. */
  getSectionEntry?: (filePath: string) => { group: 'committed' | 'changes' | 'untracked'; staged: boolean } | undefined;
  onStageFile?: (filePath: string) => void;
  stagingFile?: string | null;
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
  getSectionEntry,
  onStageFile,
  stagingFile,
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
              {node.additions > 0 && (
                <span className="additions">+{node.additions}</span>
              )}
              {node.deletions > 0 && (
                <span className="deletions">-{node.deletions}</span>
              )}
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
            getSectionEntry={getSectionEntry}
            onStageFile={onStageFile}
            stagingFile={stagingFile}
          />
        ))}
      </>
    );
  }

  // File node
  const isActive = node.fileIndex === activeFileIndex;
  const isScrollActive = !isActive && scrollHighlightIndex != null && node.fileIndex === scrollHighlightIndex;
  const isViewed = viewedFiles.has(node.path);
  const isStaged = stagedFiles.has(node.path);
  const annotationCount = getAnnotationCount(node.path);
  // Since-base mode: sidecar-driven markers (U for untracked, staged dot,
  // stage button) replace the legacy staged treatment for this row.
  const sectionEntry = getSectionEntry?.(node.path);
  const sinceBaseMode = getSectionEntry != null;
  const isUntracked = sectionEntry?.group === 'untracked';
  // isStaged comes from the EFFECTIVE set (sidecar + session overrides) —
  // the sidecar's own snapshot flag must never be ORed back in, or a file
  // unstaged this session would render staged and invert the next toggle.
  const isStageable = sinceBaseMode && !!onStageFile && sectionEntry != null && sectionEntry.group !== 'committed';

  if (hideViewedFiles && isViewed && !isActive) {
    return null;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          onClick={() => onSelectFile(node.fileIndex!)}
          onDoubleClick={() => onDoubleClickFile?.(node.fileIndex!)}
          className={`file-tree-item w-full text-left group ${isActive ? 'active' : isScrollActive ? 'scroll-active' : ''} ${annotationCount > 0 ? 'has-annotations' : ''} ${isStaged && !sinceBaseMode ? 'staged' : ''}`}
          style={{ paddingLeft }}
        >
          {/* Leading rail: [view][add][letter] then name — same anatomy as
              the sections view rows. View reveals on hover / when active; the
              stage control (since-base mode only) and letter are always shown.
              Name inherits the row font; letter/counts stay the small size. */}
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <ViewedControl isViewed={isViewed} onToggle={onToggleViewed ? () => onToggleViewed(node.path) : undefined} forceVisible={isActive} />
            {sinceBaseMode && (isStageable || isStaged) ? (
              <StageControl
                isStaged={isStaged}
                isStaging={stagingFile === node.path}
                onStage={onStageFile ? () => onStageFile(node.path) : undefined}
              />
            ) : sinceBaseMode && sectionEntry?.group === 'committed' ? (
              <CommittedDot />
            ) : sinceBaseMode && onStageFile ? (
              <span className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            ) : isStaged && !sinceBaseMode ? (
              <span className="text-[10px] text-primary font-medium flex items-center justify-center w-4 flex-shrink-0" title="Staged (git add)">+</span>
            ) : null}
            <ChangeTypeLetter status={node.file!.status} oldPath={node.file!.oldPath} untracked={isUntracked} />
            <span className="truncate">{node.name}</span>
            <AnnotationBadge count={annotationCount} />
          </div>
          <DiffCounts additions={node.file!.additions} deletions={node.file!.deletions} />
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
