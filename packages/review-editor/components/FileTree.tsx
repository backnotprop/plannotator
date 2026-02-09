import React, { useEffect, useCallback } from 'react';
import { CodeAnnotation } from '@plannotator/ui/types';

interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

interface DiffOption {
  id: string;
  label: string;
}

interface FileTreeProps {
  files: DiffFile[];
  activeFileIndex: number;
  onSelectFile: (index: number) => void;
  annotations: CodeAnnotation[];
  viewedFiles: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  hideViewedFiles?: boolean;
  onToggleHideViewed?: () => void;
  enableKeyboardNav?: boolean;
  diffOptions?: DiffOption[];
  activeDiffType?: string;
  onSelectDiff?: (diffType: string) => void;
  isLoadingDiff?: boolean;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  activeFileIndex,
  onSelectFile,
  annotations,
  viewedFiles,
  onToggleViewed,
  hideViewedFiles = false,
  onToggleHideViewed,
  enableKeyboardNav = true,
  diffOptions,
  activeDiffType,
  onSelectDiff,
  isLoadingDiff,
}) => {
  // Keyboard navigation: j/k or arrow keys
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enableKeyboardNav) return;

    // Don't interfere with input fields
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = Math.min(activeFileIndex + 1, files.length - 1);
      onSelectFile(nextIndex);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = Math.max(activeFileIndex - 1, 0);
      onSelectFile(prevIndex);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSelectFile(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      onSelectFile(files.length - 1);
    }
  }, [enableKeyboardNav, activeFileIndex, files.length, onSelectFile]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Get annotation count per file
  const getAnnotationCount = (filePath: string) => {
    return annotations.filter(a => a.filePath === filePath).length;
  };

  return (
    <aside className="w-64 border-r border-border bg-card/30 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-border/50">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Files
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {viewedFiles.size}/{files.length}
            </span>
            {onToggleHideViewed && (
              <button
                onClick={onToggleHideViewed}
                className={`p-1 rounded transition-colors ${hideViewedFiles ? 'bg-primary/15 text-primary' : 'hover:bg-muted text-muted-foreground'}`}
                title={hideViewedFiles ? "Show viewed files" : "Hide viewed files"}
              >
                {hideViewedFiles ? (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Diff selector dropdown - between header and file list */}
      {diffOptions && diffOptions.length > 0 && onSelectDiff && (
        <div className="px-2 py-2 border-b border-border/30">
          <div className="relative">
            <select
              value={activeDiffType || 'uncommitted'}
              onChange={(e) => onSelectDiff(e.target.value)}
              disabled={isLoadingDiff}
              className="w-full px-2.5 py-1.5 bg-muted rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer disabled:opacity-50 disabled:cursor-wait appearance-none pr-7"
            >
              {diffOptions.map((option, index) => (
                option.id === 'separator' ? (
                  <option key={`sep-${index}`} disabled className="text-muted-foreground">
                    ────────────
                  </option>
                ) : (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                )
              ))}
            </select>
            {/* Dropdown arrow */}
            <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
              {isLoadingDiff ? (
                <svg className="w-3.5 h-3.5 text-muted-foreground animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </div>
          </div>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto p-2">
        {files.map((file, index) => {
          const annotationCount = getAnnotationCount(file.path);
          const isActive = index === activeFileIndex;
          const isViewed = viewedFiles.has(file.path);
          const fileName = file.path.split('/').pop() || file.path;

          if (hideViewedFiles && isViewed && !isActive) {
            return null;
          }

          return (
            <button
              key={file.path}
              onClick={() => onSelectFile(index)}
              className={`file-tree-item w-full text-left group ${isActive ? 'active' : ''} ${annotationCount > 0 ? 'has-annotations' : ''}`}
            >
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <span
                  role="checkbox"
                  aria-checked={isViewed}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleViewed?.(file.path);
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
                <span className="truncate">{fileName}</span>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px]">
                {annotationCount > 0 && (
                  <span className="text-primary font-medium">{annotationCount}</span>
                )}
                <span className="additions">+{file.additions}</span>
                <span className="deletions">-{file.deletions}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-border/50 text-xs text-muted-foreground space-y-2">
        <div className="flex justify-between">
          <span>Total changes:</span>
          <span className="file-stats">
            <span className="additions">
              +{files.reduce((sum, f) => sum + f.additions, 0)}
            </span>
            <span className="deletions">
              -{files.reduce((sum, f) => sum + f.deletions, 0)}
            </span>
          </span>
        </div>
        {enableKeyboardNav && (
          <div className="text-[10px] text-muted-foreground/50 text-center">
            j/k or arrows to navigate
          </div>
        )}
      </div>
    </aside>
  );
};
