import React, { useEffect, useRef, useState } from 'react';
import { SemanticFileBadge } from './SemanticFileBadge';
import { CallFlowFileBadge } from './CallFlowFileBadge';
import { OpenInAppButton } from '@plannotator/ui/components/OpenInAppButton';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import type { DiffFileStatus } from '../types';
import { FileKindIcon } from '@plannotator/guide-viewer/FileKindIcon';

interface FileHeaderProps {
  readOnly?: boolean;
  filePath: string;
  patch: string;
  status?: DiffFileStatus;
  oldPath?: string;
  isViewed?: boolean;
  onToggleViewed?: () => void;
  /** Chrome preference: false hides the Viewed button (the `V` shortcut and
   *  viewed state are unaffected). */
  showViewedControl?: boolean;
  viewedKeyHint?: boolean;
  isStaged?: boolean;
  isStaging?: boolean;
  onStage?: () => void;
  canStage?: boolean;
  showStageControl?: boolean;
  stageError?: string | null;
  onFileComment?: (anchorEl: HTMLElement) => void;
  fileCommentButtonRef?: (el: HTMLButtonElement | null) => void;
  collapseToggle?: React.ReactNode;
  onCollapseToggle?: () => void;
  onEditFile?: () => void;
  isEditing?: boolean;
  editDisabledReason?: string | null;
  compactTouchLayout?: boolean;
  isGenerated?: boolean;
  isTest?: boolean;
  renderMarkdownView?: (fit: { iconOnly: boolean; touch: boolean }) => React.ReactNode;
  accessory?: React.ReactNode;
  openIn?: React.ReactNode;
  keepsFolder?: boolean;
}

function splitFilePath(filePath: string): { directory: string; name: string } {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash === -1) {
    return { directory: '', name: filePath };
  }

  return {
    directory: filePath.slice(0, lastSlash + 1),
    name: filePath.slice(lastSlash + 1),
  };
}

function frontEllipsize(text: string, visibleChars: number): string {
  if (text.length <= visibleChars) return text;
  return `...${text.slice(-visibleChars)}`;
}

const STATUS_LETTER: Record<DiffFileStatus, { letter: string; className: string; title: string }> = {
  added: { letter: 'A', className: 'text-success', title: 'Added file' },
  modified: { letter: 'M', className: 'text-muted-foreground', title: 'Modified file' },
  deleted: { letter: 'D', className: 'text-destructive', title: 'Deleted file' },
  renamed: { letter: 'R', className: 'text-[#007aff]', title: 'Renamed file' },
};

const FileStatusLetter: React.FC<{ status: DiffFileStatus; oldPath?: string }> = ({ status, oldPath }) => {
  if (status === 'modified') return null;
  const meta = STATUS_LETTER[status];
  const title = status === 'renamed' && oldPath ? `Renamed from ${oldPath}` : meta.title;
  return (
    <span
      className={`flex-none font-semibold leading-none ${meta.className}`}
      title={title}
      aria-label={title}
    >
      {meta.letter}
    </span>
  );
};

function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line[0] === '+' && !line.startsWith('+++')) additions++;
    else if (line[0] === '-' && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export const FileHeader: React.FC<FileHeaderProps> = ({
  filePath,
  patch,
  status,
  oldPath,
  isViewed = false,
  onToggleViewed,
  showViewedControl = true,
  viewedKeyHint = true,
  isStaged = false,
  isStaging = false,
  onStage,
  canStage = false,
  showStageControl = true,
  stageError,
  onFileComment,
  fileCommentButtonRef,
  collapseToggle,
  onCollapseToggle,
  onEditFile,
  isEditing = false,
  editDisabledReason,
  compactTouchLayout,
  readOnly = false,
  isGenerated = false,
  isTest = false,
  renderMarkdownView,
  accessory,
  openIn,
  keepsFolder = false,
}) => {
  const [headerWidth, setHeaderWidth] = useState<number>(0);
  const state = useReviewStateOptional();
  const isCompactTouchLayout = compactTouchLayout ?? state?.isCompactTouchLayout ?? false;
  const headerRef = useRef<HTMLDivElement>(null);
  const fileCommentRef = useRef<HTMLButtonElement>(null);
  const { directory, name } = splitFilePath(filePath);
  const isCompact = headerWidth > 0 && headerWidth < 760;
  const isVeryTight = headerWidth > 0 && headerWidth < 480;
  const narrow = headerWidth > 0 && headerWidth < 560;
  const foldedFolder = narrow && keepsFolder && !!directory;
  const showFilenameOnly = narrow && !foldedFolder;
  const truncatedName = showFilenameOnly
    ? frontEllipsize(
        name,
        headerWidth < 360 ? 14 : headerWidth < 420 ? 18 : headerWidth < 500 ? 24 : 32,
      )
    : name;

  useEffect(() => {
    if (!headerRef.current || typeof ResizeObserver === 'undefined') return;

    const node = headerRef.current;
    const observer = new ResizeObserver(([entry]) => {
      setHeaderWidth(entry.contentRect.width);
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const stageLabel = isVeryTight ? '' : isCompact ? (isStaging ? 'Adding' : isStaged ? 'Added' : 'Add') : (isStaging ? 'Adding...' : isStaged ? 'Added' : 'Git Add');
  const commentLabel = isVeryTight ? '' : 'Comment';
  const viewedLabel = isVeryTight ? '' : 'Viewed';
  const { additions, deletions } = React.useMemo(() => countChanges(patch), [patch]);

  return (
    <div
      ref={headerRef}
      data-file-header=""
      className={`flex-shrink-0 border-b border-border/50 flex items-center justify-between gap-2 transition-colors duration-150 hover:bg-muted/30 ${isCompactTouchLayout ? 'pr-3' : 'px-3'}`}
      style={{ height: isCompactTouchLayout ? '44px' : 'var(--panel-header-h)' }}
    >
      <div className="min-w-0 flex flex-1 items-center" onClick={onCollapseToggle} style={onCollapseToggle ? { cursor: 'pointer' } : undefined}>
        {collapseToggle}
        <span
          className={`min-w-0 flex items-center text-xs font-semibold leading-normal whitespace-nowrap ${isCompactTouchLayout ? 'flex-1' : ''}`}
          title={status === 'renamed' && oldPath ? `${oldPath} → ${filePath}` : filePath}
        >
          {status === 'renamed' && oldPath && !narrow && !isCompactTouchLayout && (
            <>
              <span className="min-w-0 overflow-hidden text-ellipsis text-muted-foreground/60">
                {oldPath}
              </span>
              <svg
                className="w-3 h-3 mx-1 flex-none text-muted-foreground/60"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </>
          )}
          {isCompactTouchLayout ? (
            <span
              data-pn-compact-file-path
              className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground [direction:rtl]"
            >
              <bdi>{filePath}</bdi>
            </span>
          ) : foldedFolder ? (
            <>
              <span data-file-header-folder="" className="min-w-0 shrink-[1000] overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground/70 [direction:rtl]">
                <bdi>{directory}</bdi>
              </span>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-foreground">{name}</span>
            </>
          ) : (
            <>
              {!showFilenameOnly && directory && (
                <span className="min-w-0 overflow-hidden text-ellipsis text-muted-foreground/70">
                  {directory}
                </span>
              )}
              <span
                className={showFilenameOnly ? 'block min-w-0 overflow-hidden whitespace-nowrap text-foreground' : 'flex-none whitespace-nowrap text-foreground'}
              >
                {truncatedName}
              </span>
            </>
          )}
        </span>
        {isTest && <FileKindIcon kind="test" size={13} className="ml-1.5 flex-none text-muted-foreground" title="Test file" />}
        {(additions > 0 || deletions > 0 || (status && status !== 'modified') || isGenerated) && (
          <span className="flex-none ml-2 flex items-center gap-1.5 text-xs leading-none">
            {additions > 0 && <span className="font-mono text-success">+{additions}</span>}
            {deletions > 0 && <span className="font-mono text-destructive">-{deletions}</span>}
            {status && <FileStatusLetter status={status} oldPath={oldPath} />}
            {isGenerated && (
              <span
                data-pn-generated-badge
                className="flex-none rounded-sm border border-border/60 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
                title="Marked linguist-generated in .gitattributes"
              >
                generated
              </span>
            )}
          </span>
        )}
      </div>
      {!isCompactTouchLayout && <div className={`flex flex-shrink-0 items-center pl-2 ${isCompact ? 'gap-1' : 'gap-2'}`}>
        {accessory}
        {renderMarkdownView?.({ iconOnly: isVeryTight, touch: false })}
        {showViewedControl && onToggleViewed && (
          <button
            onClick={onToggleViewed}
            className={`text-xs rounded transition-colors flex items-center ${viewedLabel ? 'gap-1 px-2 py-1' : 'px-1.5 py-1'} ${
              isViewed
                ? 'bg-success/15 text-success'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={`${isViewed ? 'Mark as not viewed' : 'Mark as viewed'}${viewedKeyHint ? ' (V)' : ''}`}
          >
            {isViewed ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="9" />
              </svg>
            )}
            {viewedLabel && <span>{viewedLabel}</span>}
          </button>
        )}
        {showStageControl && canStage && onStage && (
          <button
            onClick={onStage}
            disabled={isStaging}
            className={`text-xs rounded transition-colors flex items-center ${stageLabel ? 'gap-1 px-2 py-1' : 'px-1.5 py-1'} ${
              isStaging
                ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                : isStaged
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={isStaged ? "Unstage this file (A)" : "Stage this file (A)"}
          >
            {isStaging ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : isStaged ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            )}
            {stageLabel && <span>{stageLabel}</span>}
          </button>
        )}
        {stageError && (
          <span className="max-w-24 truncate text-xs text-destructive" title={stageError}>
            {stageError}
          </span>
        )}
        {onFileComment && (
          <button
            ref={(el) => {
              fileCommentRef.current = el;
              fileCommentButtonRef?.(el);
            }}
            onClick={() => fileCommentRef.current && onFileComment(fileCommentRef.current)}
            className={`text-xs rounded transition-colors flex items-center text-muted-foreground hover:text-foreground hover:bg-muted ${commentLabel ? 'gap-1 px-2 py-1' : 'px-1.5 py-1'}`}
            title="Add file-scoped comment"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-4l-4 4v-4z" />
            </svg>
            {commentLabel && <span>{commentLabel}</span>}
          </button>
        )}
        <CallFlowFileBadge filePath={filePath} oldPath={oldPath} />
        <SemanticFileBadge filePath={filePath} />
        {onEditFile && !isEditing && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!editDisabledReason) onEditFile();
            }}
            disabled={!!editDisabledReason}
            className={`text-xs rounded transition-colors flex items-center ${isVeryTight ? 'px-1.5 py-1' : 'gap-1 px-2 py-1'} ${
              editDisabledReason
                ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={editDisabledReason ?? 'Edit this file to author a suggestion (experimental)'}
            data-testid="edit-session-start"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            {!isVeryTight && <span>Edit</span>}
          </button>
        )}
        {openIn}
        {!readOnly && <OpenInAppButton
          filePath={filePath}
          base={state?.agentCwd ?? null}
          diffText={patch}
          canOpen={
            state?.canUseLiveWorkspaceActions !== false &&
            !(state?.prMetadata && !state?.agentCwd) &&
            status !== 'deleted'
          }
        />}
      </div>}
      {isCompactTouchLayout && renderMarkdownView?.({ iconOnly: false, touch: true })}
    </div>
  );
};
