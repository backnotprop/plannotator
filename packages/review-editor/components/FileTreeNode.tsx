import React from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { FileTreeNode as TreeNode } from '../utils/buildFileTree';
import { folderDisplayPath } from '../utils/fileKindTree';
import { ViewedControl, StageControl, AnnotationBadge, CommittedDot, ChangeTypeLetter, CountColumns } from './FileRowBits';
import { diffFileTreeIndent } from '@plannotator/ui/components/DiffFileTree';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';

const TREE_STEP = 12;
const DEEP_TREE_STEP = 4;

export function alignedTreeIndent(depth: number, maxIndent = Infinity): number {
  const full = Math.min(depth, Math.floor(maxIndent / TREE_STEP));
  return 8 + full * TREE_STEP + (depth - full) * DEEP_TREE_STEP;
}

export function maxTreeIndent(width: number): number {
  return Math.max(24, width - 200);
}

const FolderRow: React.FC<{ node: TreeNode; isExpanded: boolean; onToggle: () => void; paddingLeft: number }> = ({
  node,
  isExpanded,
  onToggle,
  paddingLeft,
}) => (
  <button
    type="button"
    onClick={onToggle}
    aria-expanded={isExpanded}
    data-folder-row=""
    title={folderDisplayPath(node.path)}
    className="review-folder-row"
    style={{ paddingLeft }}
  >
    <svg
      className={`w-3 h-3 flex-shrink-0 transition-transform motion-reduce:transition-none ${isExpanded ? 'rotate-90' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
    <span className="truncate">{node.name}</span>
    {(node.additions > 0 || node.deletions > 0) && (
      <CountColumns additions={node.additions} deletions={node.deletions} tone="quiet" />
    )}
  </button>
);

interface FileTreeNodeProps {
  node: TreeNode;
  indent?: (depth: number) => number;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  activeFileIndex: number;
  onSelectFile: (index: number) => void;
  onDoubleClickFile?: (index: number) => void;
  viewedFiles: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  showViewedControls?: boolean;
  hideViewedFiles: boolean;
  hiddenFiles?: ReadonlySet<string>;
  getAnnotationCount: (filePath: string) => number;
  stagedFiles: Set<string>;
  scrollHighlightIndex?: number;
  repoRoot?: string | null;
  getSectionEntry?: (filePath: string) => { group: 'committed' | 'changes' | 'untracked'; staged: boolean } | undefined;
  onStageFile?: (filePath: string) => void;
  stagingFile?: string | null;
  showStageControls?: boolean;
  markdownPreviewedPaths?: ReadonlySet<string>;
}

function hasVisibleChildren(
  node: TreeNode,
  hiddenFiles: ReadonlySet<string>,
  activeFileIndex: number,
  hideViewedFiles: boolean,
): boolean {
  if (!hideViewedFiles) return true;
  if (!node.children) return false;

  return node.children.some(child => {
    if (child.type === 'file') {
      return child.fileIndex === activeFileIndex || !hiddenFiles.has(child.path);
    }
    return hasVisibleChildren(child, hiddenFiles, activeFileIndex, hideViewedFiles);
  });
}

export const FileTreeNodeItem: React.FC<FileTreeNodeProps> = ({
  node,
  indent = diffFileTreeIndent,
  expandedFolders,
  onToggleFolder,
  activeFileIndex,
  onSelectFile,
  onDoubleClickFile,
  viewedFiles,
  onToggleViewed,
  showViewedControls = true,
  hideViewedFiles,
  hiddenFiles = viewedFiles,
  getAnnotationCount,
  stagedFiles,
  scrollHighlightIndex,
  repoRoot,
  getSectionEntry,
  onStageFile,
  stagingFile,
  showStageControls = true,
  markdownPreviewedPaths,
}) => {
  const paddingLeft = indent(node.depth);

  if (node.type === 'folder') {
    if (!hasVisibleChildren(node, hiddenFiles, activeFileIndex, hideViewedFiles)) {
      return null;
    }

    const isExpanded = expandedFolders.has(node.path);

    return (
      <>
        <FolderRow node={node} isExpanded={isExpanded} onToggle={() => onToggleFolder(node.path)} paddingLeft={paddingLeft} />
        {isExpanded && node.children?.map(child => (
          <FileTreeNodeItem
            key={child.type === 'file' ? child.path : `folder:${child.path}`}
            node={child}
            indent={indent}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            activeFileIndex={activeFileIndex}
            onSelectFile={onSelectFile}
            onDoubleClickFile={onDoubleClickFile}
            viewedFiles={viewedFiles}
            onToggleViewed={onToggleViewed}
            showViewedControls={showViewedControls}
            hideViewedFiles={hideViewedFiles}
            hiddenFiles={hiddenFiles}
            getAnnotationCount={getAnnotationCount}
            stagedFiles={stagedFiles}
            scrollHighlightIndex={scrollHighlightIndex}
            repoRoot={repoRoot}
            getSectionEntry={getSectionEntry}
            onStageFile={onStageFile}
            stagingFile={stagingFile}
            showStageControls={showStageControls}
            markdownPreviewedPaths={markdownPreviewedPaths}
          />
        ))}
      </>
    );
  }

  const isActive = node.fileIndex === activeFileIndex;
  const isScrollActive = !isActive && scrollHighlightIndex != null && node.fileIndex === scrollHighlightIndex;
  const isViewed = viewedFiles.has(node.path);
  const isStaged = stagedFiles.has(node.path);
  const annotationCount = getAnnotationCount(node.path);
  const sectionEntry = getSectionEntry?.(node.path);
  const sinceBaseMode = getSectionEntry != null;
  const isUntracked = sectionEntry?.group === 'untracked';
  const isStageable = sinceBaseMode && !!onStageFile && sectionEntry != null && sectionEntry.group !== 'committed';

  if (hideViewedFiles && hiddenFiles.has(node.path) && !isActive) {
    return null;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <button
            onClick={() => onSelectFile(node.fileIndex!)}
            onDoubleClick={() => onDoubleClickFile?.(node.fileIndex!)}
            className={`file-tree-item w-full text-left group ${isActive ? 'active' : isScrollActive ? 'scroll-active' : ''} ${annotationCount > 0 ? 'has-annotations' : ''} ${isStaged && !sinceBaseMode ? 'staged' : ''}`}
            style={{ paddingLeft }}
            title={node.path}
          />
        }
      >
          {}
          <div className="review-file-row-main">
            {showViewedControls && (
              <ViewedControl isViewed={isViewed} onToggle={onToggleViewed ? () => onToggleViewed(node.path) : undefined} forceVisible={isActive} />
            )}
            {showStageControls && (
              sinceBaseMode && (isStageable || isStaged) ? (
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
              ) : null
            )}
            <span className="review-change-letter">
              <ChangeTypeLetter status={node.file!.status} oldPath={node.file!.oldPath} untracked={isUntracked} />
            </span>
            <span className="truncate">{node.name}</span>
            {markdownPreviewedPaths?.has(node.path) && (
              <span
                data-file-tree-markdown-preview=""
                className="ml-1 inline-flex flex-shrink-0 text-primary/80"
                title="Shown rendered"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span className="sr-only">(rendered)</span>
              </span>
            )}
            <AnnotationBadge count={annotationCount} />
          </div>
          <CountColumns additions={node.file!.additions} deletions={node.file!.deletions} />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className="min-w-[160px] bg-popover text-popover-foreground border border-border rounded shadow-lg overflow-hidden py-1 transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0">
          <ContextMenu.Item
            onClick={() => { void copyTextToClipboard(node.path); }}
            className="flex items-center gap-2 mx-1 px-2 py-1.5 text-xs rounded cursor-pointer outline-none text-foreground/80 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
          >
            Copy path
          </ContextMenu.Item>
          <ContextMenu.Item
            onClick={() => { void copyTextToClipboard(node.name); }}
            className="flex items-center gap-2 mx-1 px-2 py-1.5 text-xs rounded cursor-pointer outline-none text-foreground/80 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
          >
            Copy filename
          </ContextMenu.Item>
          {repoRoot && (
            <ContextMenu.Item
              onClick={() => { void copyTextToClipboard(`${repoRoot.replace(/\/$/, '')}/${node.path}`); }}
              className="flex items-center gap-2 mx-1 px-2 py-1.5 text-xs rounded cursor-pointer outline-none text-foreground/80 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
            >
              Copy full path
            </ContextMenu.Item>
          )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
};
