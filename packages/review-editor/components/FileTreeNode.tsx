import React from 'react';
import type { FileTreeNode as TreeNode } from '../utils/buildFileTree';
import { folderDisplayPath } from '../utils/fileKindTree';
import { CountColumns } from './FileRowBits';
import { FileTreeFileRow } from './FileTreeFileRow';
import { diffFileTreeIndent } from '@plannotator/ui/components/DiffFileTree';

/** The full step of the Changes tree, and the smaller one past the cap. */
const TREE_STEP = 12;
const DEEP_TREE_STEP = 4;

/**
 * The Changes tree's indent (approved design record "review-sidebar-aligned"):
 * 12 px a level, level 0 starting on the panel's 16 px content edge (the list
 * sits 8 px in, the row pads 8). A child's chevron then sits under its
 * parent's name. Past `maxIndent` (a narrow panel, a deep tree) each further
 * level steps 4 px: never 0, so a child never lines up with its parent's
 * siblings. A deep name truncates instead; the row's title has the path.
 */
export function alignedTreeIndent(depth: number, maxIndent = Infinity): number {
  const full = Math.min(depth, Math.floor(maxIndent / TREE_STEP));
  return 8 + full * TREE_STEP + (depth - full) * DEEP_TREE_STEP;
}

/** How far the Changes tree indents in full steps in a panel `width` px
 *  wide: what is left after a row's controls, its numbers and room for a
 *  short name. */
export function maxTreeIndent(width: number): number {
  return Math.max(24, width - 200);
}

/**
 * A folder row of the Changes tree: the chevron on the content edge, the
 * (possibly merged) folder name on the label edge, then the summed counts in
 * the panel's number columns. Our own row rather than ui's
 * `DiffFileTreeFolderRow`, whose fixed padding and counts are the embeddable
 * tree's.
 */
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
  /** Left padding of a row at a depth. Default: the shared diff tree's
   *  (All files keeps it); the Changes tree passes `alignedTreeIndent`. */
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
  /** The viewed files Hide viewed takes out (`useHiddenViewedFiles`); `viewedFiles` when absent. */
  hiddenFiles?: ReadonlySet<string>;
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
  /** Markdown files shown as a rendered preview: an eye after the name. */
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

  if (hideViewedFiles && hiddenFiles.has(node.path) && !isActive) {
    return null;
  }

  return (
    <FileTreeFileRow
      path={node.path}
      name={node.name}
      fileIndex={node.fileIndex!}
      status={node.file!.status}
      oldPath={node.file!.oldPath}
      additions={node.file!.additions}
      deletions={node.file!.deletions}
      paddingLeft={paddingLeft}
      isActive={isActive}
      isScrollActive={isScrollActive}
      isViewed={isViewed}
      isStaged={isStaged}
      isStaging={stagingFile === node.path}
      isStageable={isStageable}
      isUntracked={isUntracked}
      sinceBaseMode={sinceBaseMode}
      sectionGroup={sectionEntry?.group}
      annotationCount={annotationCount}
      previewed={markdownPreviewedPaths?.has(node.path) ?? false}
      showViewedControls={showViewedControls}
      showStageControls={showStageControls}
      repoRoot={repoRoot}
      onSelectFile={onSelectFile}
      onDoubleClickFile={onDoubleClickFile}
      onToggleViewed={onToggleViewed}
      onStageFile={onStageFile}
    />
  );
};
