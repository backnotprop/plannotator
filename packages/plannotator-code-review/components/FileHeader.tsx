import React, { useEffect, useRef, useState } from 'react';
import { DiffOptionsPopover } from './DiffOptionsPopover';

interface FileHeaderProps {
  filePath: string;
  patch: string;
  isViewed?: boolean;
  onToggleViewed?: () => void;
  isStaged?: boolean;
  isStaging?: boolean;
  onStage?: () => void;
  canStage?: boolean;
  stageError?: string | null;
  onFileComment?: (anchorEl: HTMLElement) => void;
  collapseToggle?: React.ReactNode;
  onCollapseToggle?: () => void;
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

/** Sticky file header with file path, Viewed toggle, Git Add, and Copy Diff button */
export const FileHeader: React.FC<FileHeaderProps> = ({
  filePath,
  patch,
  isViewed = false,
  onToggleViewed,
  isStaged = false,
  isStaging = false,
  onStage,
  canStage = false,
  stageError,
  onFileComment,
  collapseToggle,
  onCollapseToggle,
}) => {
  const [copied, setCopied] = useState(false);
  const [headerWidth, setHeaderWidth] = useState<number>(0);
  const headerRef = useRef<HTMLDivElement>(null);
  const fileCommentRef = useRef<HTMLButtonElement>(null);
  const { directory, name } = splitFilePath(filePath);
  const isCompact = headerWidth > 0 && headerWidth < 760;
  const isTight = headerWidth > 0 && headerWidth < 600;
  const isVeryTight = headerWidth > 0 && headerWidth < 480;
  const showFilenameOnly = headerWidth > 0 && headerWidth < 560;
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
  const commentLabel = isVeryTight ? '' : isCompact ? 'Comment' : 'File Comment';
  const copyLabel = isTight ? '' : isCompact ? 'Copy' : copied ? 'Copied!' : 'Copy Diff';
  const viewedLabel = isVeryTight ? '' : 'Viewed';

  return (
    <div
      ref={headerRef}
      className="flex-shrink-0 px-3 border-b border-border/50 flex items-center justify-between gap-2"
      style={{ height: 'var(--panel-header-h)' }}
    >
      <div className="min-w-0 flex flex-1 items-center" onClick={onCollapseToggle} style={onCollapseToggle ? { cursor: 'pointer' } : undefined}>
        {collapseToggle}
        <span className="min-w-0 flex items-center text-xs font-semibold leading-none whitespace-nowrap" title={filePath}>
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
        </span>
      </div>
      <div className={`flex flex-shrink-0 items-center pl-2 ${isCompact ? 'gap-1' : 'gap-2'}`}>
        {onToggleViewed && (
          <button
            onClick={onToggleViewed}
            className={`text-xs rounded transition-colors flex items-center ${viewedLabel ? 'gap-1 px-2 py-1' : 'px-1.5 py-1'} ${
              isViewed
                ? 'bg-success/15 text-success'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={isViewed ? "Mark as not viewed (V)" : "Mark as viewed (V)"}
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
        {canStage && onStage && (
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
            ref={fileCommentRef}
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
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(patch);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch (err) {
              console.error('Failed to copy:', err);
            }
          }}
          className={`text-xs text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors flex items-center ${copyLabel ? 'gap-1 px-2 py-1' : 'px-1.5 py-1'}`}
          title="Copy this file's diff"
        >
          {copied ? (
            <>
              <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              {copyLabel && <span>{copyLabel}</span>}
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {copyLabel && <span>{copyLabel}</span>}
            </>
          )}
        </button>
        <DiffOptionsPopover />
      </div>
    </div>
  );
};
