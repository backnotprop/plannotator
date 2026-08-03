import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CodeAnnotation } from '@plannotator/ui/types';
import type { AvailableBranches, CompareTargetConfig, RecentCommit, SinceBaseSections } from '@plannotator/shared/types';
import { BaseBranchPicker } from './BaseBranchPicker';
import { PanelViewToggle } from './PanelViewToggle';
import { SemanticDiffRow, AllFilesRow } from './PanelNavRows';
import { ViewedControl, ChangeTypeLetter, StageControl, AnnotationBadge, DiffCounts, CommittedDot, TruncatedPath } from './FileRowBits';
import { SearchFileGroup } from './FileTree';
import type { ReviewSearchFileGroup, ReviewSearchMatch } from '../utils/reviewSearch';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import type { DiffFile } from '../types';

/**
 * The three-stack "All changes" (since-base) panel — the default view of a code review.
 *
 * One composite diff (merge-base → working tree + untracked) grouped by
 * lifecycle state: Committed (viewport-adaptive), Changes (staged first),
 * Untracked. Rows share the tree view's exact anatomy (file-tree-item class,
 * circle viewed control, +/- counts, A/D/R letters) so switching views never
 * changes the visual language.
 */

type SectionGroup = 'committed' | 'changes' | 'untracked';

interface SectionItem {
  file: DiffFile;
  index: number;
  group: SectionGroup;
  staged: boolean;
}

interface SectionsPanelProps {
  files: DiffFile[];
  sections: SinceBaseSections;
  width?: number;
  activeFileIndex: number;
  /** File currently visible while scrolling the all-files surface — soft
   * highlight (same treatment as the tree view). */
  scrollHighlightIndex?: number;
  onSelectFile: (index: number) => void;
  onDoubleClickFile?: (index: number) => void;
  /** j/k/arrows/Home/End file navigation (disabled while modals are open). */
  enableKeyboardNav?: boolean;
  annotations: CodeAnnotation[];
  viewedFiles: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  hideViewedFiles?: boolean;
  onToggleHideViewed?: () => void;
  /** EFFECTIVE staged set from useGitAdd (sidecar + session overrides).
   *  REQUIRED and the ONLY staging source surfaces may render from — the
   *  sidecar's own `staged` flag is a snapshot and must never be ORed in. */
  stagedFiles: Set<string>;
  stagingFile?: string | null;
  canStage?: boolean;
  onStageFile?: (filePath: string) => void;
  isLoadingDiff?: boolean;
  /** Base picker ("vs origin/main" affordance). */
  availableBranches?: AvailableBranches;
  selectedBase?: string;
  detectedBase?: string;
  onSelectBase?: (branch: string) => void;
  compareTarget?: CompareTargetConfig;
  recentCommits?: RecentCommit[];
  /** Panel view switcher (Git status / Commits / Tree), same header slot in
   * every view. */
  onSelectPanelView: (view: 'sections' | 'commits' | 'tree') => void;
  /** Offer the Commits segment (git-local sessions only). */
  showCommitsOption?: boolean;
  /** All files nav row — the review's landing view, listed first. */
  onSelectAllFiles?: () => void;
  isAllFilesActive?: boolean;
  /** Semantic diff nav row (same as tree view). */
  onSelectSemanticDiff?: () => void;
  isSemanticDiffActive?: boolean;
  semanticDiffAvailable?: boolean;
  /** Footer copy-diffs. */
  onCopyRawDiff?: () => void;
  canCopyRawDiff?: boolean;
  copyRawDiffStatus?: 'idle' | 'success' | 'error';
  /** Diff-content search — same wiring as the tree view. */
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
}

const MIN_COMMITTED_ROWS = 3;
/** Fallback row height for the first measurement pass only. */
const FALLBACK_ROW_HEIGHT = 25;

const SECTION_META: Record<SectionGroup, { label: string }> = {
  committed: { label: 'Committed' },
  changes: { label: 'Changes' },
  untracked: { label: 'Untracked' },
};

const SectionRow: React.FC<{
  item: SectionItem;
  isActive: boolean;
  isScrollActive: boolean;
  isViewed: boolean;
  annotationCount: number;
  onSelect: () => void;
  onDoubleClick?: () => void;
  onToggleViewed?: () => void;
  showStageButton: boolean;
  /** Reserve the 16px stage slot even when this row can't stage (committed
   * rows) so the view/add/count columns align across all sections. */
  reserveStageSlot: boolean;
  isStaged: boolean;
  isStaging: boolean;
  onStage?: () => void;
}> = ({ item, isActive, isScrollActive, isViewed, annotationCount, onSelect, onDoubleClick, onToggleViewed, showStageButton, reserveStageSlot, isStaged, isStaging, onStage }) => {
  const { file } = item;

  // Same row anatomy as FileTreeNode's file rows — the file-tree-item class
  // and its .active/.has-annotations states come from theme.css, so the two
  // panel views share one visual language. The .staged class (green row tint)
  // is deliberately NOT applied here: green reads as "committed", and staged
  // is its own state — the primary-colored dot + top-of-section sort carry it.
  return (
    <button
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      className={`file-tree-item w-full text-left group ${isActive ? 'active' : isScrollActive ? 'scroll-active' : ''} ${annotationCount > 0 ? 'has-annotations' : ''}`}
      style={{ paddingLeft: 8 }}
      title={file.path}
    >
      {/* Leading rail: [view][add][letter] then path. View reveals on hover
          or when the row is active; add (stage) and the change-type letter
          are always shown. Fixed-width slots keep the rail aligned. Path
          inherits the row font; only the letter/counts are the small size. */}
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <ViewedControl isViewed={isViewed} onToggle={onToggleViewed} forceVisible={isActive} />
        {showStageButton || isStaged ? (
          <StageControl isStaged={isStaged} isStaging={isStaging} onStage={onStage} />
        ) : item.group === 'committed' ? (
          <CommittedDot />
        ) : reserveStageSlot ? (
          <span className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
        ) : null}
        <ChangeTypeLetter status={file.status} oldPath={file.oldPath} untracked={item.group === 'untracked'} />
        <TruncatedPath path={file.path} />
        <AnnotationBadge count={annotationCount} />
      </div>
      <DiffCounts additions={file.additions} deletions={file.deletions} />
    </button>
  );
};

export const SectionsPanel: React.FC<SectionsPanelProps> = ({
  files,
  sections,
  width,
  activeFileIndex,
  scrollHighlightIndex,
  onSelectFile,
  onDoubleClickFile,
  enableKeyboardNav,
  annotations,
  viewedFiles,
  onToggleViewed,
  hideViewedFiles,
  onToggleHideViewed,
  stagedFiles,
  stagingFile,
  canStage,
  onStageFile,
  isLoadingDiff,
  availableBranches,
  selectedBase,
  detectedBase,
  onSelectBase,
  compareTarget,
  recentCommits,
  onSelectPanelView,
  showCommitsOption,
  onSelectAllFiles,
  isAllFilesActive,
  onSelectSemanticDiff,
  isSemanticDiffActive,
  semanticDiffAvailable,
  onCopyRawDiff,
  canCopyRawDiff,
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
}) => {
  const [collapsed, setCollapsed] = useState<Set<SectionGroup>>(new Set());
  const [committedExpanded, setCommittedExpanded] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);
  const isSearchVisible = !!onSearchChange && (isSearchOpen || !!searchQuery.trim());

  const items = useMemo<Record<SectionGroup, SectionItem[]>>(() => {
    const grouped: Record<SectionGroup, SectionItem[]> = { committed: [], changes: [], untracked: [] };
    files.forEach((file, index) => {
      if (hideViewedFiles && viewedFiles.has(file.path) && index !== activeFileIndex) return;
      const entry = sections.files[file.path];
      // A file in the composite patch with no status entry has a clean
      // working tree — it is committed branch work.
      let group: SectionGroup = entry?.group ?? 'committed';
      // stagedFiles is the EFFECTIVE set (sidecar + session overrides) — the
      // sidecar's own flag must not be ORed back in, or a file unstaged this
      // session would keep its stale staged dot until the next refresh.
      const staged = stagedFiles.has(file.path);
      // Staging an untracked file makes it tracked+staged in git, but the
      // sidecar snapshot still says untracked until the next diff refresh —
      // anticipate the server and show it under Changes now. Unstaging drops
      // it from the effective set, which falls back to the sidecar group.
      if (group === 'untracked' && staged) group = 'changes';
      // Mirror image: a file that was ALREADY staged when the sidecar was
      // computed (entry.staged — the snapshot flag, deliberately used here
      // to detect "was pre-staged") and is an ADD becomes untracked again
      // when the session unstages it. Staged modifications correctly stay
      // in Changes; staged renames are a refresh-heals edge.
      else if (group === 'changes' && (entry?.staged ?? false) && !staged && file.status === 'added') {
        group = 'untracked';
      }
      grouped[group].push({ file, index, group, staged });
    });
    // Staged work floats to the top of Changes.
    grouped.changes.sort((a, b) => Number(b.staged) - Number(a.staged));
    return grouped;
  }, [files, sections, hideViewedFiles, viewedFiles, activeFileIndex, stagedFiles]);

  const annotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of annotations) {
      counts.set(a.filePath, (counts.get(a.filePath) ?? 0) + 1);
    }
    return counts;
  }, [annotations]);

  // --- Committed sizing: measured, not guessed -------------------------------
  // Contract: Changes + Untracked always render fully; Committed gets exactly
  // the leftover viewport, floor MIN_COMMITTED_ROWS. Instead of estimating
  // chrome with constants (which is wrong on every viewport but the one it was
  // tuned on), measure the real layout:
  //   budget    = scrollport height (chrome above/below is outside it)
  //   otherH    = rendered content height MINUS the committed block
  //   rowH      = a real committed row's rendered height
  //   fit       = (budget − otherH [− expander row]) / rowH
  // `otherH` excludes the committed block, so changing the visible count does
  // not change the inputs — the computation settles in a single pass.
  const scrollportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const committedBlockRef = useRef<HTMLDivElement | null>(null);
  const [measuredFit, setMeasuredFit] = useState(MIN_COMMITTED_ROWS);

  const committedTotal = items.committed.length;
  const committedVisibleCount = committedExpanded || committedTotal <= MIN_COMMITTED_ROWS
    ? committedTotal
    : Math.max(MIN_COMMITTED_ROWS, Math.min(measuredFit, committedTotal));

  const remeasureCommittedFit = useCallback(() => {
    const scrollport = scrollportRef.current;
    const content = contentRef.current;
    const committedBlock = committedBlockRef.current;
    // Only measure when the committed block is actually rendered. While search
    // results replace the sections (or Committed is collapsed / empty) the
    // block is null, and measuring `content − 0` against unrelated content
    // would yield a nonsensical (negative) fit; keep the last good value.
    if (!scrollport || !content || !committedBlock) return;
    const committedH = committedBlock.offsetHeight;
    const rowEl = committedBlock?.querySelector('.file-tree-item');
    const rowH = rowEl instanceof HTMLElement && rowEl.offsetHeight > 0
      ? rowEl.offsetHeight
      : FALLBACK_ROW_HEIGHT;
    const otherH = content.offsetHeight - committedH;
    const budget = scrollport.clientHeight - otherH;
    const fitAll = Math.floor(budget / rowH);
    // When truncating, one row of budget goes to the "N more files" expander.
    const next = fitAll >= committedTotal
      ? committedTotal
      : Math.floor((budget - rowH) / rowH);
    setMeasuredFit((prev) => (prev === next ? prev : next));
  }, [committedTotal]);

  useLayoutEffect(() => {
    remeasureCommittedFit();
  }, [remeasureCommittedFit, items, collapsed, committedExpanded, isSearchVisible, searchQuery]);

  useEffect(() => {
    const el = scrollportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => remeasureCommittedFit());
    observer.observe(el);
    return () => observer.disconnect();
  }, [remeasureCommittedFit]);

  // "N added" mirrors the rows' staged dots. stagedFiles is the EFFECTIVE
  // set (sidecar + session overrides), so its size IS the count — unioning
  // the sidecar back in would resurrect files unstaged this session.
  const stagedCount = stagedFiles.size;

  // Keyboard file navigation (j/k/arrows/Home/End) over the panel's VISIBLE
  // rows in render order. The tree view had this via FileTree; the sections
  // view replaces FileTree, so without this the default view had no file-nav
  // keys even though the help modal advertises them.
  const visualOrder = useMemo(() => {
    const order: number[] = [];
    if (!collapsed.has('committed')) {
      for (const it of items.committed.slice(0, committedVisibleCount)) order.push(it.index);
    }
    if (!collapsed.has('changes')) for (const it of items.changes) order.push(it.index);
    if (!collapsed.has('untracked')) for (const it of items.untracked) order.push(it.index);
    return order;
  }, [items, committedVisibleCount, collapsed]);

  useEffect(() => {
    if (enableKeyboardNav === false) return;
    const handler = (e: KeyboardEvent) => {
      if (searchQuery.trim()) return; // search results own the panel
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        // Base UI popups carry ARIA roles directly (Menu.Popup role="menu",
        // Popover.Popup role="dialog") — no wrapper attribute needed.
        active.closest('[role="menu"], [role="dialog"], [role="listbox"]')
      ) return;
      if (visualOrder.length === 0) return;
      const navKey = ['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key);
      // Clear focus from a previously-clicked row so its focus ring doesn't
      // linger on the wrong file while keyboard nav moves the active highlight.
      if (navKey && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const pos = visualOrder.indexOf(activeFileIndex);
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        onSelectFile(visualOrder[pos < visualOrder.length - 1 ? pos + 1 : (pos === -1 ? 0 : pos)]);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        onSelectFile(visualOrder[pos > 0 ? pos - 1 : 0]);
      } else if (e.key === 'Home') {
        e.preventDefault();
        onSelectFile(visualOrder[0]);
      } else if (e.key === 'End') {
        e.preventDefault();
        onSelectFile(visualOrder[visualOrder.length - 1]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enableKeyboardNav, visualOrder, activeFileIndex, onSelectFile, searchQuery]);

  const toggleSection = useCallback((group: SectionGroup) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const renderRows = (list: SectionItem[]) =>
    list.map((item) => (
      <SectionRow
        key={item.index}
        item={item}
        isActive={item.index === activeFileIndex}
        isScrollActive={item.index !== activeFileIndex && scrollHighlightIndex != null && item.index === scrollHighlightIndex}
        isViewed={viewedFiles.has(item.file.path)}
        annotationCount={annotationCounts.get(item.file.path) ?? 0}
        onSelect={() => onSelectFile(item.index)}
        onDoubleClick={onDoubleClickFile ? () => onDoubleClickFile(item.index) : undefined}
        onToggleViewed={onToggleViewed ? () => onToggleViewed(item.file.path) : undefined}
        showStageButton={!!canStage && !!onStageFile && item.group !== 'committed'}
        reserveStageSlot={!!canStage && !!onStageFile}
        isStaged={item.staged}
        isStaging={stagingFile === item.file.path}
        onStage={onStageFile ? () => onStageFile(item.file.path) : undefined}
      />
    ));

  const sectionHeader = (group: SectionGroup) => (
    <button
      onClick={() => toggleSection(group)}
      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
    >
      <svg
        className={`w-2.5 h-2.5 transition-transform ${collapsed.has(group) ? '-rotate-90' : ''}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
      <span className="text-[11px] font-medium">{SECTION_META[group].label}</span>
    </button>
  );

  return (
    <aside
      ref={asideRef}
      className="border-r border-border/50 bg-card/30 flex flex-col flex-shrink-0 overflow-hidden"
      style={{ width: width ?? 256 }}
    >
      {/* Header — the view toggle IS the label (left slot), controls right;
          identical layout to the tree view so nothing moves between views. */}
      <div className="px-3 flex items-center border-b border-border/50 flex-shrink-0" style={{ height: 'var(--panel-header-h)' }}>
        <div className="w-full flex items-center justify-between gap-2">
          <PanelViewToggle view="sections" onSelect={onSelectPanelView} showCommits={showCommitsOption} />
          <div className="flex items-center gap-1.5">
            {stagedCount > 0 && (
              <span className="text-xs text-primary font-medium">
                {stagedCount} added
              </span>
            )}
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
            {onToggleHideViewed && (
              <button
                onClick={onToggleHideViewed}
                className={`p-1 rounded transition-colors ${hideViewedFiles ? 'bg-primary/15 text-primary' : 'hover:bg-muted text-muted-foreground'}`}
                title={hideViewedFiles ? 'Show viewed files' : 'Hide viewed files'}
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
            <span className="text-xs text-muted-foreground tabular-nums">
              {viewedFiles.size}/{files.length}
            </span>
          </div>
        </div>
      </div>

      {/* Search input — identical wiring to the tree view. */}
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
              onChange={(e) => onSearchChange?.(e.target.value)}
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

      {/* Baseline row — the ONLY comparison control in this view. The sections
          view IS the since-base comparison; other diff modes live in the tree
          view's dropdown, and the header toggle is the path between them. */}
      {onSelectBase && selectedBase && detectedBase && availableBranches && compareTarget && (
        <div className="px-2 py-1.5 border-b border-border/30 flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">vs</span>
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

      {/* Sections (or search results — same swap the tree view does) */}
      <div ref={scrollportRef} className="flex-1 min-h-0">
      <OverlayScrollArea className="h-full">
        <div ref={contentRef} className="px-1 py-1">
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
          {/* Nav rows — shared with the tree view, same order. */}
          {semanticDiffAvailable && onSelectSemanticDiff && (
            <SemanticDiffRow active={isSemanticDiffActive ?? false} onClick={onSelectSemanticDiff} />
          )}
          {onSelectAllFiles && (
            <AllFilesRow
              active={isAllFilesActive ?? false}
              onClick={onSelectAllFiles}
              additions={totalAdditions}
              deletions={totalDeletions}
            />
          )}

          {/* Committed — viewport-adaptive (measured; see remeasureCommittedFit) */}
          {items.committed.length > 0 && (
            <div className="mb-1">
              {sectionHeader('committed')}
              {!collapsed.has('committed') && (
                <div ref={committedBlockRef}>
                  {renderRows(items.committed.slice(0, committedVisibleCount))}
                  {committedVisibleCount < items.committed.length && (
                    <button
                      onClick={() => setCommittedExpanded(true)}
                      className="w-full text-left px-2 py-1 text-[11px] text-primary/80 underline underline-offset-2 decoration-primary/40 hover:text-primary hover:decoration-primary transition-colors"
                    >
                      {items.committed.length - committedVisibleCount} more files
                    </button>
                  )}
                  {committedExpanded && items.committed.length > MIN_COMMITTED_ROWS && (
                    <button
                      onClick={() => setCommittedExpanded(false)}
                      className="w-full text-left px-2 py-1 text-[11px] text-primary/80 underline underline-offset-2 decoration-primary/40 hover:text-primary hover:decoration-primary transition-colors"
                    >
                      Show fewer
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Changes — always fully rendered, staged first */}
          <div className="mb-1">
            {sectionHeader('changes')}
            {!collapsed.has('changes') &&
              (items.changes.length > 0 ? (
                renderRows(items.changes)
              ) : (
                <div className="px-2 py-1 text-[11px] text-muted-foreground/50">No working-tree changes</div>
              ))}
          </div>

          {/* Untracked — always fully rendered */}
          {items.untracked.length > 0 && (
            <div className="mb-1">
              {sectionHeader('untracked')}
              {!collapsed.has('untracked') && renderRows(items.untracked)}
            </div>
          )}
          </>
          )}
        </div>
      </OverlayScrollArea>
      </div>

      {/* Footer: copy + totals (same as tree view) */}
      <div className="px-2 py-1.5 border-t border-border/50 text-xs text-muted-foreground flex-shrink-0">
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
            <span className="additions">+{totalAdditions}</span>
            <span className="deletions">-{totalDeletions}</span>
          </span>
        </div>
      </div>
    </aside>
  );
};
