import React, { useEffect, useCallback } from 'react';
import { CodeAnnotation } from '@plannotator/ui/types';

interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

interface FileTreeProps {
  files: DiffFile[];
  activeFileIndex: number;
  onSelectFile: (index: number) => void;
  annotations: CodeAnnotation[];
  enableKeyboardNav?: boolean;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  activeFileIndex,
  onSelectFile,
  annotations,
  enableKeyboardNav = true,
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

  // Get file extension for icon
  const getFileIcon = (path: string) => {
    const ext = path.split('.').pop()?.toLowerCase();
    const iconMap: Record<string, string> = {
      ts: 'text-blue-400',
      tsx: 'text-blue-400',
      js: 'text-yellow-400',
      jsx: 'text-yellow-400',
      css: 'text-pink-400',
      scss: 'text-pink-400',
      json: 'text-green-400',
      md: 'text-gray-400',
      py: 'text-green-400',
      rs: 'text-orange-400',
      go: 'text-cyan-400',
    };
    return iconMap[ext || ''] || 'text-muted-foreground';
  };

  return (
    <aside className="w-64 border-r border-border bg-card/30 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-border/50">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Files
          </span>
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {files.length}
          </span>
        </div>
        {enableKeyboardNav && (
          <div className="text-[10px] text-muted-foreground/60 mt-1">
            j/k or arrows to navigate
          </div>
        )}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto p-2">
        {files.map((file, index) => {
          const annotationCount = getAnnotationCount(file.path);
          const isActive = index === activeFileIndex;
          const fileName = file.path.split('/').pop() || file.path;
          const dirPath = file.path.split('/').slice(0, -1).join('/');

          return (
            <button
              key={file.path}
              onClick={() => onSelectFile(index)}
              className={`file-tree-item w-full text-left group ${isActive ? 'active' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {/* File icon */}
                  <svg
                    className={`w-3.5 h-3.5 flex-shrink-0 ${getFileIcon(file.path)}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="truncate font-medium">{fileName}</span>
                </div>
                {dirPath && (
                  <div className="text-[10px] text-muted-foreground/60 truncate ml-5">
                    {dirPath}
                  </div>
                )}
              </div>

              {/* Stats */}
              <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                <span className="file-stats">
                  <span className="additions">+{file.additions}</span>
                  <span className="deletions">-{file.deletions}</span>
                </span>
                {annotationCount > 0 && (
                  <span className="w-4 h-4 rounded-full bg-primary/20 text-primary text-[10px] flex items-center justify-center">
                    {annotationCount}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Summary */}
      <div className="p-3 border-t border-border/50 text-xs text-muted-foreground">
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
      </div>
    </aside>
  );
};
