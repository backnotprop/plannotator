import React, { useRef, useState } from 'react';

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
}) => {
  const [copied, setCopied] = useState(false);
  const fileCommentRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex-shrink-0 px-4 bg-card border-b border-border flex items-center justify-between" style={{ height: 'var(--panel-header-h)' }}>
      <span className="text-xs font-semibold text-foreground">{filePath}</span>
      <div className="flex items-center gap-2">
        {onToggleViewed && (
          <button
            onClick={onToggleViewed}
            className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
              isViewed
                ? 'bg-success/15 text-success'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={isViewed ? "Mark as not viewed" : "Mark as viewed"}
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
            Viewed
          </button>
        )}
        {canStage && onStage && (
          <button
            onClick={onStage}
            disabled={isStaging}
            className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
              isStaging
                ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                : isStaged
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={isStaged ? "Unstage this file (git reset)" : "Stage this file (git add)"}
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
            {isStaging ? 'Adding...' : isStaged ? 'Added' : 'Git Add'}
          </button>
        )}
        {stageError && (
          <span className="text-xs text-destructive">{stageError}</span>
        )}
        {onFileComment && (
          <button
            ref={fileCommentRef}
            onClick={() => fileCommentRef.current && onFileComment(fileCommentRef.current)}
            className="text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-muted"
            title="Add file-scoped comment"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-4l-4 4v-4z" />
            </svg>
            File Comment
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
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors flex items-center gap-1"
          title="Copy this file's diff"
        >
          {copied ? (
            <>
              <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy Diff
            </>
          )}
        </button>
      </div>
    </div>
  );
};
