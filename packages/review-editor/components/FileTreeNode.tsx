import React from 'react';
import type { FileTreeNode as TreeNode } from '../utils/buildFileTree';
import type { FileMetadata } from '../types';

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
  fileMeta?: Record<string, FileMetadata>;
  hideLaneLabel?: boolean;
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
  fileMeta,
  hideLaneLabel,
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
            fileMeta={fileMeta}
            hideLaneLabel={hideLaneLabel}
          />
        ))}
      </>
    );
  }

  // File node
  const isActive = node.fileIndex === activeFileIndex;
  const isViewed = viewedFiles.has(node.path);
  const isStaged = stagedFiles?.has(node.path) ?? false;
  const annotationCount = getAnnotationCount(node.path);
  const meta = fileMeta?.[node.path];

  if (hideViewedFiles && isViewed && !isActive) {
    return null;
  }

  return (
    <button
      onClick={() => onSelectFile(node.fileIndex!)}
      onDoubleClick={() => onDoubleClickFile?.(node.fileIndex!)}
      className={`file-tree-item w-full text-left group ${isActive ? 'active' : ''} ${annotationCount > 0 ? 'has-annotations' : ''} ${isStaged ? 'staged' : ''}`}
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
        {meta && meta.lanes && (() => {
          const srcChar = meta.source === 'committed' ? 'C' : meta.source === 'uncommitted' ? 'S' : meta.source === 'mixed' ? 'M' : null;
          const srcWord = meta.source === 'committed' ? 'committed' : meta.source === 'uncommitted' ? 'staged' : meta.source === 'mixed' ? 'committed + staged' : null;
          const srcColor = meta.source === 'committed' ? 'text-blue-400' : meta.source === 'uncommitted' ? 'text-orange-400' : meta.source === 'mixed' ? 'text-purple-400' : 'text-muted-foreground/60';
          const laneLabel = meta.lanes.length === 1 ? meta.lanes[0] : `${meta.lanes.length} lanes`;
          const hoverTitle = (() => {
            if (meta.laneDetails && meta.laneDetails.length > 1) {
              return meta.laneDetails
                .map((d) => `${d.source === 'committed' ? 'committed' : 'staged'} to ${d.lane}`)
                .join(', ');
            }
            if (srcWord && laneLabel) return `${srcWord} to ${meta.lanes.join(', ')}`;
            if (srcWord) return srcWord;
            return meta.lanes.join(', ');
          })();
          const displayLabel = [srcChar, hideLaneLabel ? null : laneLabel].filter(Boolean).join(' · ');
          return displayLabel ? (
            <span title={hoverTitle} className={`font-medium leading-none ${srcColor}`}>{displayLabel}</span>
          ) : null;
        })()}
        {annotationCount > 0 && (
          <span className="text-primary font-medium">{annotationCount}</span>
        )}
        <span className="additions">+{node.file!.additions}</span>
        <span className="deletions">-{node.file!.deletions}</span>
      </div>
    </button>
  );
};
