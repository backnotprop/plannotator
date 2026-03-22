import React, { useEffect, useCallback, useState, useMemo } from 'react';
import { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffOption, WorktreeInfo } from '@plannotator/shared/types';
import { buildFileTree, getAncestorPaths, getAllFolderPaths } from '../utils/buildFileTree';
import { FileTreeNodeItem } from './FileTreeNode';
import { getReviewSearchSideLabel, type ReviewSearchFileGroup, type ReviewSearchMatch } from '../utils/reviewSearch';

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
  viewedFiles: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  hideViewedFiles?: boolean;
  onToggleHideViewed?: () => void;
  enableKeyboardNav?: boolean;
  diffOptions?: DiffOption[];
  activeDiffType?: string;
  onSelectDiff?: (diffType: string) => void;
  isLoadingDiff?: boolean;
  width?: number;
  worktrees?: WorktreeInfo[];
  activeWorktreePath?: string | null;
  onSelectWorktree?: (path: string | null) => void;
  currentBranch?: string;
  stagedFiles?: Set<string>;
  searchQuery?: string;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  onSearchChange?: (value: string) => void;
  onSearchClear?: () => void;
  searchGroups?: ReviewSearchFileGroup[];
  searchMatches?: ReviewSearchMatch[];
  activeSearchMatchId?: string | null;
  onSelectSearchMatch?: (matchId: string) => void;
  onStepSearchMatch?: (direction: 1 | -1) => void;
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
  width,
  worktrees,
  activeWorktreePath,
  onSelectWorktree,
  currentBranch,
  stagedFiles,
  searchQuery = '',
  searchInputRef,
  onSearchChange,
  onSearchClear,
  searchGroups = [],
  searchMatches = [],
  activeSearchMatchId,
  onSelectSearchMatch,
  onStepSearchMatch,
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

  const annotationCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of annotations) {
      map.set(a.filePath, (map.get(a.filePath) ?? 0) + 1);
    }
    return map;
  }, [annotations]);

  const getAnnotationCount = useCallback((filePath: string) => {
    return annotationCountMap.get(filePath) ?? 0;
  }, [annotationCountMap]);

  const tree = useMemo(() => buildFileTree(files), [files]);

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [prevTree, setPrevTree] = useState(tree);

  // Expand all folders when tree changes (initial render + diff switch)
  if (tree !== prevTree) {
    setPrevTree(tree);
    setExpandedFolders(new Set(getAllFolderPaths(tree)));
  }

  // Auto-expand ancestors of the active file so j/k nav always reveals the target
  useEffect(() => {
    if (files[activeFileIndex]) {
      const ancestors = getAncestorPaths(files[activeFileIndex].path);
      setExpandedFolders(prev => {
        const missing = ancestors.filter(p => !prev.has(p));
        if (missing.length === 0) return prev;
        const next = new Set(prev);
        for (const p of missing) next.add(p);
        return next;
      });
    }
  }, [activeFileIndex, files]);

  const handleToggleFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return (
    <aside className="border-r border-border bg-card/30 flex flex-col flex-shrink-0 overflow-hidden" style={{ width: width ?? 256 }}>
      {/* Search input */}
      {onSearchChange && (
        <div className="px-2 flex items-center border-b border-border/50" style={{ height: 'var(--panel-header-h)' }}>
          <div className="relative flex-1">
            <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35m1.85-5.15a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
                  e.preventDefault();
                  return;
                }
                if (e.key === 'Enter' && searchMatches.length > 0) {
                  e.preventDefault();
                  onStepSearchMatch?.(e.shiftKey ? -1 : 1);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (searchQuery) {
                    onSearchClear?.();
                  } else {
                    (e.target as HTMLInputElement).blur();
                  }
                }
              }}
              placeholder="Search diff..."
              className="w-full pl-7 pr-7 py-1.5 bg-muted rounded-md text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            {searchQuery && (
              <button
                onClick={onSearchClear}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-background/50 text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          {searchQuery.trim() && (
            <div className="mt-1 text-[10px] text-muted-foreground/60 px-0.5">
              {searchMatches.length} result{searchMatches.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="px-3 py-2 border-b border-border/50">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {searchQuery.trim() ? 'Results' : 'Files'}
          </span>
          <div className="flex items-center gap-1.5">
            {stagedFiles && stagedFiles.size > 0 && (
              <>
                <span className="text-xs text-primary font-medium">
                  {stagedFiles.size} added
                </span>
                <span className="text-muted-foreground/40">·</span>
              </>
            )}
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

      {/* Worktree context switcher — only shown when worktrees exist */}
      {worktrees && worktrees.length > 0 && onSelectWorktree && (
        <div className="px-2 pt-2 pb-1.5 border-b border-border/30">
          <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1 px-0.5">Context</div>
          <div className="relative">
            <select
              value={activeWorktreePath || ''}
              onChange={(e) => onSelectWorktree(e.target.value || null)}
              disabled={isLoadingDiff}
              className={`w-full px-2.5 py-1.5 rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer disabled:opacity-50 disabled:cursor-wait appearance-none pr-7 ${
                activeWorktreePath
                  ? 'bg-primary/10 border border-primary/30'
                  : 'bg-muted'
              }`}
            >
              <option value="">{currentBranch || 'Main repo'}</option>
              {worktrees.map(wt => (
                <option key={wt.path} value={wt.path}>
                  {(wt.branch || wt.path.split('/').pop()) + ' (worktree)'}
                </option>
              ))}
            </select>
            <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
              <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* Diff type selector — always the same base options */}
      {diffOptions && diffOptions.length > 0 && onSelectDiff && (
        <div className="px-2 py-1.5 border-b border-border/30">
          {worktrees && worktrees.length > 0 && (
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1 px-0.5">View</div>
          )}
          <div className="relative">
            <select
              value={activeDiffType || 'uncommitted'}
              onChange={(e) => onSelectDiff(e.target.value)}
              disabled={isLoadingDiff}
              className="w-full px-2.5 py-1.5 bg-muted rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer disabled:opacity-50 disabled:cursor-wait appearance-none pr-7"
            >
              {diffOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
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

      {/* File tree or search results */}
      <div className="flex-1 overflow-y-auto p-2">
        {searchQuery.trim() ? (
          searchGroups.length > 0 ? (
            searchGroups.map((group) => (
              <SearchFileGroup
                key={group.filePath}
                group={group}
                searchQuery={searchQuery}
                activeSearchMatchId={activeSearchMatchId ?? null}
                onSelectFile={onSelectFile}
                onSelectMatch={onSelectSearchMatch}
              />
            ))
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground/50">
              No matches found
            </div>
          )
        ) : (
          tree.map(node => (
            <FileTreeNodeItem
              key={node.type === 'file' ? node.path : `folder:${node.path}`}
              node={node}
              expandedFolders={expandedFolders}
              onToggleFolder={handleToggleFolder}
              activeFileIndex={activeFileIndex}
              onSelectFile={onSelectFile}
              viewedFiles={viewedFiles}
              onToggleViewed={onToggleViewed}
              hideViewedFiles={hideViewedFiles}
              getAnnotationCount={getAnnotationCount}
              stagedFiles={stagedFiles}
            />
          ))
        )}
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

// --- Search result components ---

function highlightQuery(text: string, query: string) {
  if (!query.trim()) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  // split with a capturing group puts matches at odd indices (1, 3, 5...)
  return parts.map((part, i) =>
    i % 2 === 1
      ? <mark key={i} className="search-match-highlight">{part}</mark>
      : part
  );
}

const SearchFileGroup: React.FC<{
  group: ReviewSearchFileGroup;
  searchQuery: string;
  activeSearchMatchId: string | null;
  onSelectFile: (index: number) => void;
  onSelectMatch?: (matchId: string) => void;
}> = ({ group, searchQuery, activeSearchMatchId, onSelectFile, onSelectMatch }) => {
  const [collapsed, setCollapsed] = useState(false);
  const fileName = group.filePath.split('/').pop() || group.filePath;
  const dirPath = group.filePath.includes('/') ? group.filePath.slice(0, group.filePath.lastIndexOf('/')) : '';

  return (
    <div className="mb-1">
      {/* File header */}
      <button
        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs hover:bg-muted transition-colors group"
        onClick={() => setCollapsed(prev => !prev)}
      >
        <svg className={`w-3 h-3 text-muted-foreground/50 transition-transform flex-shrink-0 ${collapsed ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <svg className="w-3.5 h-3.5 text-muted-foreground/60 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <span className="truncate text-foreground font-medium">{fileName}</span>
        {dirPath && <span className="truncate text-muted-foreground/50 text-[10px]">{dirPath}</span>}
        <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/50 bg-muted rounded px-1.5 py-0.5">
          {group.matches.length}
        </span>
      </button>

      {/* Match rows */}
      {!collapsed && (
        <div className="ml-3 border-l border-border/30 pl-2">
          {group.matches.map((match) => (
            <SearchMatchRow
              key={match.id}
              match={match}
              searchQuery={searchQuery}
              isActive={activeSearchMatchId === match.id}
              onSelect={() => {
                onSelectFile(group.fileIndex);
                onSelectMatch?.(match.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const SearchMatchRow: React.FC<{
  match: ReviewSearchMatch;
  searchQuery: string;
  isActive: boolean;
  onSelect: () => void;
}> = ({ match, searchQuery, isActive, onSelect }) => {
  const sideLabel = getReviewSearchSideLabel(match.side);
  const sideColor = match.side === 'addition' ? 'text-success' : match.side === 'deletion' ? 'text-destructive' : 'text-muted-foreground/60';

  return (
    <button
      className={`w-full text-left px-2 py-1 rounded-sm text-[11px] font-mono transition-colors flex items-start gap-1.5 ${
        isActive
          ? 'bg-primary/15 text-foreground'
          : 'hover:bg-muted/50 text-muted-foreground'
      }`}
      onClick={onSelect}
    >
      <span className="flex-shrink-0 text-muted-foreground/40 w-7 text-right tabular-nums">{match.lineNumber}</span>
      <span className={`flex-shrink-0 w-6 text-[9px] font-semibold uppercase ${sideColor}`}>{sideLabel}</span>
      <span className="truncate leading-relaxed">{highlightQuery(match.snippet, searchQuery)}</span>
    </button>
  );
};
