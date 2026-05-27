import React, { useEffect, useCallback, useState, useMemo } from 'react';
import { CodeAnnotation } from '@plannotator/ui/types';
import type { AvailableBranches, CompareTargetConfig, DiffOption, JjEvoLogEntry, RecentCommit, WorktreeInfo } from '@plannotator/shared/types';
import { buildFileTree, getAncestorPaths, getAllFolderPaths, getVisualFileOrder } from '../utils/buildFileTree';
import { FileTreeNodeItem } from './FileTreeNode';
import { BaseBranchPicker } from './BaseBranchPicker';
import { EvoLogPicker } from './EvoLogPicker';
import { DiffTypePicker } from './DiffTypePicker';
import { WorktreePicker } from './WorktreePicker';
import { getReviewSearchSideLabel, type ReviewSearchFileGroup, type ReviewSearchMatch } from '../utils/reviewSearch';
import type { DiffFile } from '../types';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';

interface FileTreeProps {
  files: DiffFile[];
  activeFileIndex: number;
  onSelectFile: (index: number) => void;
  onDoubleClickFile?: (index: number) => void;
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
  /** Compare target picker — base branch for Git, bookmark/revision for jj. */
  availableBranches?: AvailableBranches;
  selectedBase?: string;
  detectedBase?: string;
  onSelectBase?: (branch: string) => void;
  compareTarget?: CompareTargetConfig;
  /** HEAD ancestry for the commit-baseline picker (git only, #709). */
  recentCommits?: RecentCommit[];
  /** Evolution log entries for the current jj change (jj-evolog mode only). */
  jjEvologs?: JjEvoLogEntry[];
  /** Default evolog commit ID to compare against (second evolog entry). */
  detectedEvoBase?: string;
  stagedFiles?: Set<string>;
  onCopyRawDiff?: () => void;
  canCopyRawDiff?: boolean;
  copyRawDiffStatus?: 'idle' | 'success' | 'error';
  searchQuery?: string;
  isSearchOpen?: boolean;
  isSearchPending?: boolean;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  onOpenSearch?: () => void;
  onSearchChange?: (value: string) => void;
  onSearchClear?: () => void;
  onSearchClose?: () => void;
  searchGroups?: ReviewSearchFileGroup[];
  searchMatches?: ReviewSearchMatch[];
  activeSearchMatchId?: string | null;
  onSelectSearchMatch?: (matchId: string) => void;
  onStepSearchMatch?: (direction: 1 | -1) => void;
  onSelectAllFiles?: () => void;
  isAllFilesActive?: boolean;
  scrollHighlightIndex?: number;
  /** Absolute repo root for the "Copy full path" context menu item. Null/undefined hides the option (e.g. PR review mode). */
  repoRoot?: string | null;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  activeFileIndex,
  onSelectFile,
  onDoubleClickFile,
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
  availableBranches,
  selectedBase,
  detectedBase,
  onSelectBase,
  compareTarget,
  recentCommits,
  jjEvologs,
  detectedEvoBase,
  stagedFiles,
  onCopyRawDiff,
  canCopyRawDiff = false,
  copyRawDiffStatus = 'idle',
  searchQuery = '',
  isSearchOpen = false,
  isSearchPending,
  searchInputRef,
  onOpenSearch,
  onSearchChange,
  onSearchClear,
  onSearchClose,
  searchGroups = [],
  searchMatches = [],
  activeSearchMatchId,
  onSelectSearchMatch,
  onStepSearchMatch,
  onSelectAllFiles,
  isAllFilesActive = false,
  scrollHighlightIndex,
  repoRoot,
}) => {
  const isSearchVisible = !!onSearchChange && (isSearchOpen || !!searchQuery.trim());

  const tree = useMemo(() => buildFileTree(files), [files]);
  const allFolderPaths = useMemo(() => getAllFolderPaths(tree), [tree]);
  const visualOrder = useMemo(() => getVisualFileOrder(tree), [tree]);

  // Keyboard navigation: j/k or arrow keys
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enableKeyboardNav) return;

    // Don't interfere with input fields
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    // Yield keyboard nav when a floating overlay owns the focus — Radix
    // DropdownMenu / Popover / Dialog handle arrow keys themselves, and the
    // old native <select> used to absorb these natively. `data-radix-popper-
    // content-wrapper` is Radix's shared wrapper for every floating primitive
    // (Popover, DropdownMenu, Tooltip, HoverCard), so it catches the base
    // picker and worktree picker in addition to role-based dialogs/menus.
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.closest('[role="menu"], [role="dialog"], [role="listbox"], [data-radix-popper-content-wrapper]')
    ) {
      return;
    }

    const visualPos = visualOrder.indexOf(activeFileIndex);

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (visualPos < visualOrder.length - 1) {
        onSelectFile(visualOrder[visualPos + 1]);
      }
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (visualPos > 0) {
        onSelectFile(visualOrder[visualPos - 1]);
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSelectFile(visualOrder[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      onSelectFile(visualOrder[visualOrder.length - 1]);
    }
  }, [enableKeyboardNav, activeFileIndex, visualOrder, onSelectFile]);

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

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(allFolderPaths));
  const [prevTree, setPrevTree] = useState(tree);

  // Expand all folders when tree changes (initial render + diff switch)
  if (tree !== prevTree) {
    setPrevTree(tree);
    setExpandedFolders(new Set(allFolderPaths));
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

  const areAllFoldersExpanded = allFolderPaths.length > 0 && allFolderPaths.every(path => expandedFolders.has(path));

  const handleToggleAllFolders = useCallback(() => {
    setExpandedFolders(areAllFoldersExpanded ? new Set() : new Set(allFolderPaths));
  }, [allFolderPaths, areAllFoldersExpanded]);

  return (
    <aside className="border-r border-border/50 bg-card/30 flex flex-col flex-shrink-0 overflow-hidden" style={{ width: width ?? 256 }}>
      {/* Header */}
      <div className="px-3 flex items-center border-b border-border/50" style={{ height: 'var(--panel-header-h)' }}>
        <div className="w-full flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
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
            {onOpenSearch && (
              <button
                onClick={onOpenSearch}
                className={`p-1 rounded transition-colors ${isSearchVisible ? 'bg-primary/15 text-primary' : 'hover:bg-muted text-muted-foreground'}`}
                title="Search diff (Cmd/Ctrl+F)"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35m1.85-5.15a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />
                </svg>
              </button>
            )}
            <button
              onClick={handleToggleAllFolders}
              disabled={allFolderPaths.length === 0}
              className="p-1 rounded transition-colors hover:bg-muted text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
              title={areAllFoldersExpanded ? 'Collapse all folders' : 'Expand all folders'}
            >
              {areAllFoldersExpanded ? (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 2l7 6 7-6" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 22l7-6 7 6" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 8l7-6 7 6" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 16l7 6 7-6" />
                </svg>
              )}
            </button>
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

      {/* Search input */}
      {isSearchVisible && (
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
                if (e.key === 'Enter' && searchMatches.length > 0 && !isSearchPending) {
                  e.preventDefault();
                  onStepSearchMatch?.(e.shiftKey ? -1 : 1);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (searchQuery) {
                    onSearchClear?.();
                  } else {
                    onSearchClose?.();
                    (e.target as HTMLInputElement).blur();
                  }
                }
              }}
              placeholder="Search diff..."
              className="w-full pl-7 py-1.5 pr-7 bg-muted rounded text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {searchQuery.trim() && !isSearchPending && (
                <span className="text-[10px] text-muted-foreground/40 tabular-nums">
                  {searchMatches.length}
                </span>
              )}
              <button
                onClick={searchQuery ? onSearchClear : onSearchClose}
                className="p-0.5 rounded hover:bg-background/50 text-muted-foreground hover:text-foreground transition-colors"
                title={searchQuery ? 'Clear search' : 'Close search'}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Worktree + diff selectors — combined row when both present */}
      {((worktrees && worktrees.length > 0 && onSelectWorktree) || (diffOptions && diffOptions.length > 0 && onSelectDiff)) && (
        <div className="px-2 py-1.5 border-b border-border/30 flex gap-2">
          {worktrees && worktrees.length > 0 && onSelectWorktree && (
            <div className="flex-1 min-w-0">
              <WorktreePicker
                worktrees={worktrees}
                activeWorktreePath={activeWorktreePath ?? null}
                currentBranch={currentBranch}
                onSelect={onSelectWorktree}
                disabled={isLoadingDiff}
              />
            </div>
          )}
          {diffOptions && diffOptions.length > 0 && onSelectDiff && (
            <div className="flex-1 min-w-0">
              <DiffTypePicker
                options={diffOptions}
                activeDiffType={activeDiffType || 'uncommitted'}
                onSelect={onSelectDiff}
                isLoading={isLoadingDiff}
                hasBasePicker={!!onSelectBase && !!availableBranches}
              />
            </div>
          )}
        </div>
      )}

      {/* Evolog picker — only shown when jj-evolog diff type is active */}
      {activeDiffType === 'jj-evolog' &&
        onSelectBase &&
        selectedBase &&
        jjEvologs &&
        jjEvologs.length >= 2 &&
        detectedEvoBase && (
          <div className="px-2 py-1.5 border-b border-border/30 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">
              from evolution
            </span>
            <div className="flex-1 min-w-0">
              <EvoLogPicker
                entries={jjEvologs}
                selectedCommitId={selectedBase}
                detectedCommitId={detectedEvoBase}
                onSelect={onSelectBase}
                disabled={isLoadingDiff}
              />
            </div>
          </div>
        )}

      {/* Compare target picker — only relevant for base-dependent diff types (not evolog) */}
      {activeDiffType !== 'jj-evolog' &&
        onSelectBase &&
        selectedBase &&
        detectedBase &&
        availableBranches &&
        activeDiffType &&
        compareTarget?.diffTypes.includes(activeDiffType) && (
          <div className="px-2 py-1.5 border-b border-border/30 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">
              {compareTarget.picker.rowLabel}
            </span>
            <div className="flex-1 min-w-0">
              <BaseBranchPicker
                availableBranches={availableBranches}
                selectedBase={selectedBase}
                detectedBase={detectedBase}
                onSelectBase={onSelectBase}
                disabled={isLoadingDiff}
                copy={compareTarget.picker}
                recentCommits={recentCommits}
              />
            </div>
          </div>
        )}

      {/* File tree or search results */}
      <OverlayScrollArea className="flex-1 min-h-0">
      <div className="px-1 py-1">
        {searchQuery.trim() ? (
          isSearchPending ? (
            <div className="py-6 text-center text-xs text-muted-foreground/50">
              Searching…
            </div>
          ) : searchGroups.length > 0 ? (
            searchGroups.map((group) => (
              <SearchFileGroup
                key={group.filePath}
                group={group}
                searchQuery={searchQuery}
                activeSearchMatchId={activeSearchMatchId ?? null}
                onSelectMatch={onSelectSearchMatch}
              />
            ))
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground/50">
              No matches found
            </div>
          )
        ) : (
          <>
          {onSelectAllFiles && (
            <button
              onClick={onSelectAllFiles}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors mb-0.5 ${
                isAllFilesActive
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6.878V6a2.25 2.25 0 012.25-2.25h7.5A2.25 2.25 0 0118 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 004.5 9v.878m13.5-3A2.25 2.25 0 0119.5 9v.878m-13.5 0A2.25 2.25 0 003 12v3a2.25 2.25 0 002.25 2.25h13.5A2.25 2.25 0 0021 15v-3a2.25 2.25 0 00-2.25-2.25m-13.5 0h13.5" />
              </svg>
              <span>All files</span>
              <span className="ml-auto text-[10px] tabular-nums opacity-60">
                <span className="text-green-500">+{files.reduce((s, f) => s + f.additions, 0)}</span>
                {' '}
                <span className="text-red-500">-{files.reduce((s, f) => s + f.deletions, 0)}</span>
              </span>
            </button>
          )}
          {tree.map(node => (
            <FileTreeNodeItem
              key={node.type === 'file' ? node.path : `folder:${node.path}`}
              node={node}
              expandedFolders={expandedFolders}
              onToggleFolder={handleToggleFolder}
              activeFileIndex={isAllFilesActive ? -1 : activeFileIndex}
              scrollHighlightIndex={isAllFilesActive ? scrollHighlightIndex : undefined}
              onSelectFile={onSelectFile}
              onDoubleClickFile={onDoubleClickFile}
              viewedFiles={viewedFiles}
              onToggleViewed={onToggleViewed}
              hideViewedFiles={hideViewedFiles}
              getAnnotationCount={getAnnotationCount}
              stagedFiles={stagedFiles}
              repoRoot={repoRoot}
            />
          ))}
          </>
        )}
      </div>
      </OverlayScrollArea>

      {/* Footer */}
      <div className="px-2 py-1.5 border-t border-border/50 text-xs text-muted-foreground">
        <div className="flex items-center justify-between">
          {onCopyRawDiff ? (
            <button
              onClick={onCopyRawDiff}
              disabled={!canCopyRawDiff}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Copy all raw diffs to clipboard (Cmd/Ctrl+Shift+C)"
            >
              {copyRawDiffStatus === 'success' ? (
                <svg className="w-3 h-3 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : copyRawDiffStatus === 'error' ? (
                <svg className="w-3 h-3 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
              {copyRawDiffStatus === 'success' ? 'Copied' : copyRawDiffStatus === 'error' ? 'Failed' : 'Copy diffs'}
            </button>
          ) : (
            <span />
          )}
          <span className="file-stats inline-flex items-center gap-1.5">
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

// --- Search result components ---

function highlightQuery(text: string, query: string) {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const regex = new RegExp(`(${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
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
  onSelectMatch?: (matchId: string) => void;
}> = ({ group, searchQuery, activeSearchMatchId, onSelectMatch }) => {
  const [collapsed, setCollapsed] = useState(false);
  const fileName = group.filePath.split('/').pop() || group.filePath;
  const dirPath = group.filePath.includes('/') ? group.filePath.slice(0, group.filePath.lastIndexOf('/')) : '';

  return (
    <div className="mb-1">
      {/* File header */}
      <button
        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs hover:bg-muted transition-colors group"
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
      className={`w-full text-left px-2 py-1 rounded-sm text-xs font-mono transition-colors flex items-start gap-1.5 ${
        isActive
          ? 'bg-primary/15 text-foreground'
          : 'hover:bg-muted/50 text-muted-foreground'
      }`}
      onClick={onSelect}
    >
      <span className="flex-shrink-0 text-muted-foreground/40 w-7 text-right tabular-nums">{match.lineNumber}</span>
      <span className={`flex-shrink-0 w-6 text-[10px] font-semibold uppercase ${sideColor}`}>{sideLabel}</span>
      <span className="truncate leading-relaxed">{highlightQuery(match.snippet, searchQuery)}</span>
    </button>
  );
};
