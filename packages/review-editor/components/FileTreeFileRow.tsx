import React from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { DiffFile } from '../types';
import { ViewedControl, StageControl, AnnotationBadge, CommittedDot, ChangeTypeLetter, CountColumns } from './FileRowBits';

export interface FileTreeFileRowProps {
  path: string;
  name: string;
  fileIndex: number;
  status: DiffFile['status'];
  oldPath: DiffFile['oldPath'];
  additions: number;
  deletions: number;
  paddingLeft: number;
  isActive: boolean;
  isScrollActive: boolean;
  isViewed: boolean;
  isStaged: boolean;
  isStaging: boolean;
  isStageable: boolean;
  isUntracked: boolean;
  sinceBaseMode: boolean;
  sectionGroup: 'committed' | 'changes' | 'untracked' | undefined;
  annotationCount: number;
  previewed: boolean;
  showViewedControls: boolean;
  showStageControls: boolean;
  repoRoot?: string | null;
  onSelectFile: (index: number) => void;
  onDoubleClickFile?: (index: number) => void;
  onToggleViewed?: (filePath: string) => void;
  onStageFile?: (filePath: string) => void;
}

export const FileTreeFileRow = React.memo(function FileTreeFileRow({
  path,
  name,
  fileIndex,
  status,
  oldPath,
  additions,
  deletions,
  paddingLeft,
  isActive,
  isScrollActive,
  isViewed,
  isStaged,
  isStaging,
  isStageable,
  isUntracked,
  sinceBaseMode,
  sectionGroup,
  annotationCount,
  previewed,
  showViewedControls,
  showStageControls,
  repoRoot,
  onSelectFile,
  onDoubleClickFile,
  onToggleViewed,
  onStageFile,
}: FileTreeFileRowProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <button
            onClick={() => onSelectFile(fileIndex)}
            onDoubleClick={() => onDoubleClickFile?.(fileIndex)}
            className={`file-tree-item w-full text-left group ${isActive ? 'active' : isScrollActive ? 'scroll-active' : ''} ${annotationCount > 0 ? 'has-annotations' : ''} ${isStaged && !sinceBaseMode ? 'staged' : ''}`}
            style={{ paddingLeft }}
            title={path}
          />
        }
      >
          {/* Leading rail: [view][add][letter] then name — same anatomy as
              the sections view rows. The stage control (since-base mode
              only) and the letter are always shown. The name inherits the
              row font; the letter and counts stay the small size. The counts
              sit in the panel's two number columns. */}
          <div className="review-file-row-main">
            {showViewedControls && (
              <ViewedControl isViewed={isViewed} onToggle={onToggleViewed ? () => onToggleViewed(path) : undefined} forceVisible={isActive} />
            )}
            {showStageControls && (
              sinceBaseMode && (isStageable || isStaged) ? (
                <StageControl
                  isStaged={isStaged}
                  isStaging={isStaging}
                  onStage={onStageFile ? () => onStageFile(path) : undefined}
                />
              ) : sinceBaseMode && sectionGroup === 'committed' ? (
                <CommittedDot />
              ) : sinceBaseMode && onStageFile ? (
                <span className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              ) : isStaged && !sinceBaseMode ? (
                <span className="text-[10px] text-primary font-medium flex items-center justify-center w-4 flex-shrink-0" title="Staged (git add)">+</span>
              ) : null
            )}
            <span className="review-change-letter">
              <ChangeTypeLetter status={status} oldPath={oldPath} untracked={isUntracked} />
            </span>
            <span className="truncate">{name}</span>
            {previewed && (
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
          <CountColumns additions={additions} deletions={deletions} />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className="min-w-[160px] bg-popover text-popover-foreground border border-border rounded shadow-lg overflow-hidden py-1 transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0">
          <ContextMenu.Item
            onClick={() => { void copyTextToClipboard(path); }}
            className="flex items-center gap-2 mx-1 px-2 py-1.5 text-xs rounded cursor-pointer outline-none text-foreground/80 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
          >
            Copy path
          </ContextMenu.Item>
          <ContextMenu.Item
            onClick={() => { void copyTextToClipboard(name); }}
            className="flex items-center gap-2 mx-1 px-2 py-1.5 text-xs rounded cursor-pointer outline-none text-foreground/80 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
          >
            Copy filename
          </ContextMenu.Item>
          {repoRoot && (
            <ContextMenu.Item
              onClick={() => { void copyTextToClipboard(`${repoRoot.replace(/\/$/, '')}/${path}`); }}
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
});
