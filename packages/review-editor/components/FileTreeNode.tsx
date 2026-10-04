import React from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { FileTreeNode as TreeNode } from '../utils/buildFileTree';
import { ViewedControl, StageControl, AnnotationBadge, CommittedDot } from './FileRowBits';
import {
  DiffFileTreeFolderRow,
  DiffFileTreeFileRowContent,
  diffFileTreeIndent,
} from '@plannotator/ui/components/DiffFileTree';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';

interface FileTreeNodeProps {
  node: TreeNode;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  activeFileIndex: number;
  onSelectFile: (index: number) => void;
  onDoubleClickFile?: (index: number) => void;
  viewedFiles: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  showViewedControls?: boolean;
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
  showStageControls?: boolean;
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
  showViewedControls = true,
  hideViewedFiles,
  getAnnotationCount,
  stagedFiles,
  scrollHighlightIndex,
  repoRoot,
  getSectionEntry,
  onStageFile,
  stagingFile,
  showStageControls = true,
}) => {
  const paddingLeft = diffFileTreeIndent(node.depth);

  if (node.type === 'folder') {
    if (!hasVisibleChildren(node, viewedFiles, activeFileIndex, hideViewedFiles)) {
      return null;
    }

    const isExpanded = expandedFolders.has(node.path);

    return (
      <>
        <DiffFileTreeFolderRow node={node} isExpanded={isExpanded} onToggle={() => onToggleFolder(node.path)} />
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
            showViewedControls={showViewedControls}
            hideViewedFiles={hideViewedFiles}
            getAnnotationCount={getAnnotationCount}
            stagedFiles={stagedFiles}
            scrollHighlightIndex={scrollHighlightIndex}
            repoRoot={repoRoot}
            getSectionEntry={getSectionEntry}
            onStageFile={onStageFile}
            stagingFile={stagingFile}
            showStageControls={showStageControls}
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
      <ContextMenu.Trigger
        render={
          <button
            onClick={() => onSelectFile(node.fileIndex!)}
            onDoubleClick={() => onDoubleClickFile?.(node.fileIndex!)}
            className={`file-tree-item w-full text-left group ${isActive ? 'active' : isScrollActive ? 'scroll-active' : ''} ${annotationCount > 0 ? 'has-annotations' : ''} ${isStaged && !sinceBaseMode ? 'staged' : ''}`}
            style={{ paddingLeft }}
          />
        }
      >
          {/* Leading rail: [view][add][letter] then name — same anatomy as
              the sections view rows. View reveals on hover / when active; the
              stage control (since-base mode only) and letter are always shown.
              Name inherits the row font; letter/counts stay the small size. */}
          <DiffFileTreeFileRowContent
            file={node.file!}
            name={node.name}
            untracked={isUntracked}
            afterName={<AnnotationBadge count={annotationCount} />}
            leading={<>
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
            </>}
          />
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
