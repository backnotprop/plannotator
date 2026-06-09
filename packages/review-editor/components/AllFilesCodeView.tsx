import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSingularPatch } from '@pierre/diffs';
import type {
  CodeViewItem,
  CodeViewLineSelection,
  CodeViewOptions,
  SelectedLineRange,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import type {
  CodeAnnotationType,
  ConventionalDecoration,
  ConventionalLabel,
  TokenAnnotationMeta,
} from '@plannotator/ui/types';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { usePierreTheme } from '../hooks/usePierreTheme';
import type { DiffFile } from '../types';
import { buildFileTree, getVisualFileOrder } from '../utils/buildFileTree';
import { ToolbarHost, type ToolbarHostHandle } from './ToolbarHost';
import { FileHeader } from './FileHeader';
import type { AIChatEntry } from '../hooks/useAIChat';

/**
 * AllFilesCodeView (migration phases P1 + P2 + P3)
 *
 * Renders every changed file through ONE Pierre `CodeView` inside a single
 * scroll container, replacing the legacy per-file `FileDiff` list
 * (`AllFilesDiffView`). Gated behind the `allFilesCodeView` config flag.
 *
 * P1 established the static, uncontrolled `initialItems` skeleton. P2 locked
 * down item identity and routed navigation + line selection through CodeView's
 * own APIs. P3 (this phase) moves collapse + the full Plannotator FileHeader
 * INTO CodeView via the `renderCustomHeader` render slot:
 *
 *  - The full Plannotator `FileHeader` (Viewed toggle, Git Add/undo + stage
 *    error, file-scoped comment, Copy Diff, semantic badge, diff-options
 *    popover, responsive labels) renders inside CodeView's header slot. File
 *    identity (path / patch) is sourced from the `CodeViewItem` handed to the
 *    render slot, not from an external active-file side channel.
 *  - Collapse lives in CodeView item state: toggling sets `item.collapsed`,
 *    bumps `item.version`, and calls `viewer.updateItem(item)` (the Diffshub
 *    pattern). The Diffshub anchor fix keeps a collapsed file from jumping out
 *    of view: if the item's top is above the current scrollTop, we re-anchor it
 *    via `scrollTo({ type: 'item', align: 'start' })` after the update.
 *  - Because the custom header replaces Pierre's built-in header chrome,
 *    `itemMetrics.diffHeaderHeight` is pinned to the real header height
 *    (`--panel-header-h` = 33px) and `hunkSeparatorHeight` to the value our
 *    `usePierreTheme` unsafeCSS forces (24px height + 4px*2 margin = 32px), so
 *    CodeView's virtualization estimates stay accurate (no scroll drift /
 *    sticky-header misalignment).
 *
 * Annotation rendering, full-content hunk expansion, search highlighting, and
 * the worker pool remain later phases.
 */
interface AllFilesCodeViewProps {
  files: DiffFile[];
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  expandUnchanged?: boolean;
  fontFamily?: string;
  fontSize?: string;
  // Annotation / toolbar wiring (P2). Mirrors AllFilesDiffView's surface so the
  // toolbar opens against the file CodeView reports for a selection.
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotationForFile: (
    filePath: string,
    type: CodeAnnotationType,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
    conventionalLabel?: ConventionalLabel,
    decorations?: ConventionalDecoration[],
    tokenMeta?: TokenAnnotationMeta,
  ) => void;
  onEditAnnotation: (
    id: string,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
    conventionalLabel?: ConventionalLabel | null,
    decorations?: ConventionalDecoration[],
  ) => void;
  // Header actions (P3). Mirror AllFilesDiffView's header surface.
  onAddFileCommentForFile?: (filePath: string, text: string) => void;
  viewedFiles?: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  stagedFiles?: Set<string>;
  onStage?: (filePath: string) => void;
  canStageFiles?: boolean;
  stagingFile?: string | null;
  stageError?: string | null;
  prUrl?: string;
  prDiffScope?: string;
  // File-tree active-file highlight follows scroll.
  onVisibleFileChange?: (filePath: string | null) => void;
  // Only handle [/]/z/v/a/c/x keyboard nav when this surface is the active panel.
  isActive?: boolean;
  // AI props (optional — surfaced into the toolbar like AllFilesDiffView).
  aiAvailable?: boolean;
  onAskAI?: (question: string) => void;
  isAILoading?: boolean;
  onViewAIResponse?: (questionId?: string) => void;
  aiHistoryForSelection?: AIChatEntry[];
}

// Diffshub-style stable path-based id allocation. Plannotator's file list is
// normally one entry per (new) path, so ids are identity (id === path) in the
// common case. Pathological patches (e.g. a delete + re-add of the same path,
// or repeated paths) would otherwise collapse two files onto one CodeView item,
// breaking selection/scroll identity — so a per-base suffix disambiguates them
// while still keeping a filePath <-> itemId map for the bridge.
interface ItemIdentity {
  items: CodeViewItem<undefined>[];
  /** Maps a file path to the CodeView item id that owns it. */
  filePathToItemId: Map<string, string>;
  /** Maps a CodeView item id back to the originating file path. */
  itemIdToFilePath: Map<string, string>;
}

function buildItemIdentity(files: DiffFile[], visualOrder: number[]): ItemIdentity {
  const items: CodeViewItem<undefined>[] = [];
  const filePathToItemId = new Map<string, string>();
  const itemIdToFilePath = new Map<string, string>();
  const usedIds = new Set<string>();
  const nextSuffixByBase = new Map<string, number>();

  const allocateId = (path: string): string => {
    if (!usedIds.has(path)) {
      usedIds.add(path);
      return path;
    }
    let suffix = nextSuffixByBase.get(path) ?? 2;
    let id = `${path}?${suffix}`;
    while (usedIds.has(id)) {
      suffix++;
      id = `${path}?${suffix}`;
    }
    nextSuffixByBase.set(path, suffix + 1);
    usedIds.add(id);
    return id;
  };

  for (const index of visualOrder) {
    const file = files[index];
    if (!file) continue;
    const id = allocateId(file.path);
    // fileDiff.cacheKey is seeded from the (stable) item id so worker
    // highlighting (a later phase) caches by a unique per-item key even when
    // two items share the same display path.
    const fileDiff = getSingularPatch(file.patch);
    fileDiff.cacheKey = id;
    items.push({ id, type: 'diff', fileDiff, version: 0 });
    // First occurrence of a path wins the canonical lookup so the file tree
    // (keyed by path) navigates to the primary item for that path.
    if (!filePathToItemId.has(file.path)) {
      filePathToItemId.set(file.path, id);
    }
    itemIdToFilePath.set(id, file.path);
  }

  return { items, filePathToItemId, itemIdToFilePath };
}

// Resolved pixel height of the custom header. Must equal FileHeader's fixed
// container height (`style={{ height: 'var(--panel-header-h)' }}`) so CodeView's
// virtualization reserves exactly the right space for the header. FileHeader is
// internally responsive (ResizeObserver shrinks labels) but its OUTER box height
// is fixed, so the responsive label changes never alter the row height.
const PANEL_HEADER_HEIGHT = 33; // --panel-header-h
// Hunk separator height forced by usePierreTheme unsafeCSS:
//   [data-separator='line-info'] { height: 24px; margin-block: 4px; }
// => 24 + 4*2 = 32. Pierre's default differs, so omitting this drifts.
const HUNK_SEPARATOR_HEIGHT = 32;

export const AllFilesCodeView: React.FC<AllFilesCodeViewProps> = ({
  files,
  diffStyle,
  diffOverflow,
  diffIndicators,
  lineDiffType,
  disableLineNumbers,
  disableBackground,
  expandUnchanged,
  fontFamily,
  fontSize,
  onLineSelection,
  onAddAnnotationForFile,
  onEditAnnotation,
  onAddFileCommentForFile,
  viewedFiles,
  onToggleViewed,
  stagedFiles,
  onStage,
  canStageFiles = false,
  stagingFile,
  stageError,
  prUrl,
  prDiffScope,
  onVisibleFileChange,
  isActive = true,
  aiAvailable = false,
  onAskAI,
  isAILoading = false,
  onViewAIResponse,
  aiHistoryForSelection = [],
}) => {
  // showFileHeader: true suppresses usePierreTheme's `[data-title]` hide rule.
  // With renderCustomHeader the built-in header runs in 'custom' mode (only the
  // header-custom slot, no [data-title] element), so that rule is moot either
  // way — we keep `true` to be explicit that the built-in title is irrelevant
  // here (our FileHeader owns all header chrome).
  const pierreTheme = usePierreTheme({ fontFamily, fontSize, showFileHeader: true });
  const viewerRef = useRef<CodeViewHandle<undefined> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolbarHostRef = useRef<ToolbarHostHandle>(null);
  // The file path CodeView currently reports as visible (active-file highlight).
  // Reset on diff switch so stepping/highlighting never anchors on an old file.
  const visibleFileRef = useRef<string | null>(null);

  // The file CodeView last reported a selection / line-click in. The toolbar is
  // keyed off this file's path + patch, but the value is sourced from the
  // CodeView callback context (item.id) — never from geometry inference.
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  // A range whose toolbar must open only after the ToolbarHost remounts against
  // the newly-activated file (its patch/filePath props changed this render).
  const pendingToolbarRange = useRef<SelectedLineRange | null>(null);

  // File-scoped comment popover anchor (P3). Anchored by the FileHeader button
  // ref handed through the render slot — NOT by querying the recycled/portaled
  // header DOM (CodeView reuses header elements, so a DOM lookup is unreliable).
  const [fileCommentAnchor, setFileCommentAnchor] = useState<{ el: HTMLElement; filePath: string } | null>(null);
  // Per-file-comment-button ref map so the `c` keyboard shortcut can anchor the
  // popover without DOM querying. Populated by FileHeader's onFileComment ref.
  const fileCommentButtonRefs = useRef<Map<string, HTMLElement>>(new Map());

  // Previous snapshots of header-driving props (see the header-refresh effect
  // below). Declared up here with the other refs so the diff-switch reset effect
  // can resync them.
  const prevViewedRef = useRef<Set<string> | undefined>(viewedFiles);
  const prevStagedRef = useRef<Set<string> | undefined>(stagedFiles);
  const prevStagingRef = useRef<string | null | undefined>(stagingFile);
  const prevStageErrorRef = useRef<string | null | undefined>(stageError);

  // Order items by the current visual file-tree order — same ordering the
  // legacy all-files view uses, so the two surfaces present files identically.
  const visualOrder = useMemo(() => {
    const tree = buildFileTree(files);
    return getVisualFileOrder(tree);
  }, [files]);

  // `initialItems` + the identity maps are recomputed whenever the file set
  // changes. CodeView is uncontrolled (the Diffshub pattern) and only seeds
  // `initialItems` once per instance, so changing `files` in place would NOT
  // re-seed it. The ALL_FILES dock panel is reused (single fixed panel id,
  // `getPanel().api.setActive()`), and diff-type/base/PR-scope/PR/whitespace
  // switches all call `setFiles(...)` WITHOUT recreating the panel — so this
  // component instance survives a diff switch. To keep CodeView in sync with
  // the new diff we remount it via `fileSetKey` (below), which re-runs the
  // `initialItems` seed against the freshly computed identity. This restores
  // the legacy AllFilesDiffView behavior (which reads `files` live).
  const identity = useMemo<ItemIdentity>(
    () => buildItemIdentity(files, visualOrder),
    [files, visualOrder],
  );
  const { filePathToItemId, itemIdToFilePath } = identity;

  // Stable identity of the current diff. Changes whenever the file set or any
  // file's patch content changes (diff type / base / whitespace / PR switch),
  // and is used as the CodeView `key` to force a remount + fresh seed. Path +
  // patch length is a cheap proxy for "the diff changed" without hashing every
  // byte of every patch.
  const fileSetKey = useMemo(
    () => `${files.length}:${files.map((f) => `${f.path}#${f.patch.length}`).join('|')}`,
    [files],
  );

  // Visual-order list of file paths (for [/] stepping). Derived from items so it
  // matches CodeView's rendered order exactly.
  const orderedItemIds = useMemo(
    () => identity.items.map((item) => item.id),
    [identity.items],
  );

  const activePatch = useMemo(
    () => (activeFilePath ? files.find((f) => f.path === activeFilePath)?.patch ?? '' : ''),
    [files, activeFilePath],
  );

  // The CodeView callback context gives us the owning item directly, so file
  // identity comes from `item.id` instead of header-geometry inference. If the
  // toolbar is already keyed to this file, open immediately; otherwise activate
  // the file first and defer until ToolbarHost remounts against its patch.
  const routeSelectionToToolbar = useCallback(
    (range: SelectedLineRange, filePath: string) => {
      if (activeFilePath === filePath) {
        toolbarHostRef.current?.handleLineSelectionEnd(range);
      } else {
        pendingToolbarRange.current = range;
        setActiveFilePath(filePath);
      }
    },
    [activeFilePath],
  );

  // Once ToolbarHost has remounted against the newly-active file, flush the
  // deferred selection so the toolbar opens with the correct file + range.
  useEffect(() => {
    if (pendingToolbarRange.current && activePatch) {
      toolbarHostRef.current?.handleLineSelectionEnd(pendingToolbarRange.current);
      pendingToolbarRange.current = null;
    }
  }, [activePatch]);

  const handleAddAnnotation = useCallback(
    (
      type: CodeAnnotationType,
      text?: string,
      suggestedCode?: string,
      originalCode?: string,
      conventionalLabel?: ConventionalLabel,
      decorations?: ConventionalDecoration[],
      tokenMeta?: TokenAnnotationMeta,
    ) => {
      if (!activeFilePath) return;
      onAddAnnotationForFile(
        activeFilePath,
        type,
        text,
        suggestedCode,
        originalCode,
        conventionalLabel,
        decorations,
        tokenMeta,
      );
    },
    [activeFilePath, onAddAnnotationForFile],
  );

  // Reset to a fresh state when the file set changes (diff switch). CodeView
  // itself is remounted via `fileSetKey`; this clears the React-side toolbar /
  // selection / active-file / header state so nothing keys off a file from the
  // old diff.
  useEffect(() => {
    setActiveFilePath(null);
    setSelectedLines(null);
    pendingToolbarRange.current = null;
    visibleFileRef.current = null;
    setFileCommentAnchor(null);
    fileCommentButtonRefs.current.clear();
    // Resync the header-refresh snapshots to the current props so the post-
    // remount header-refresh effect computes deltas against THIS diff, not the
    // previous one (the remounted items already seed from live props).
    prevViewedRef.current = viewedFiles;
    prevStagedRef.current = stagedFiles;
    prevStagingRef.current = stagingFile;
    prevStageErrorRef.current = stageError;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSetKey]);

  // --- Collapse via CodeView item state (Diffshub pattern + anchor fix) ------

  const toggleItemCollapsed = useStableCallback((itemId: string) => {
    const handle = viewerRef.current;
    const viewer = handle?.getInstance();
    const item = handle?.getItem(itemId);
    if (handle == null || viewer == null || item == null) return;

    // If the item top is above scrollTop, re-anchor after the update so the
    // collapsing file stays in view (it would otherwise shift the content
    // below it upward, jumping the scroll). Diffshub anchor fix.
    const itemTop = viewer.getTopForItem(itemId);
    item.collapsed = item.collapsed !== true;
    item.version = (item.version ?? 0) + 1;
    if (!handle.updateItem(item)) return;

    if (itemTop != null && itemTop < viewer.getScrollTop()) {
      viewer.scrollTo({ type: 'item', id: itemId, align: 'start' });
    }
  });

  // Collapse a file (idempotent) — used by viewed+collapse so marking a file
  // viewed also folds it away, matching the legacy view.
  const collapseItem = useStableCallback((itemId: string) => {
    const handle = viewerRef.current;
    const item = handle?.getItem(itemId);
    if (handle == null || item == null || item.collapsed === true) return;
    item.collapsed = true;
    item.version = (item.version ?? 0) + 1;
    handle.updateItem(item);
  });

  const isItemCollapsed = useCallback((itemId: string): boolean => {
    return viewerRef.current?.getItem(itemId)?.collapsed === true;
  }, []);

  // Force CodeView to re-render an item's slots (header included) WITHOUT
  // otherwise mutating it. Pierre renders `renderCustomHeader` into a portal
  // driven by an internal store that only republishes on item mount / unmount /
  // updateItem. Because `renderCustomHeader` is a stable callback (its identity
  // never changes), the memoized SlotPortals will NOT re-render when external
  // React state captured by the closure (viewedFiles / stagedFiles /
  // stagingFile / stageError) changes. Bumping `item.version` + `updateItem`
  // republishes the slot so the header reflects the new state — the same path
  // collapse already uses.
  const refreshItem = useCallback((itemId: string) => {
    const handle = viewerRef.current;
    const item = handle?.getItem(itemId);
    if (handle == null || item == null) return;
    item.version = (item.version ?? 0) + 1;
    handle.updateItem(item);
  }, []);

  // --- Header actions ---------------------------------------------------------

  const handleToggleViewedAndCollapse = useStableCallback((filePath: string, itemId: string) => {
    const wasViewed = viewedFiles?.has(filePath) ?? false;
    onToggleViewed?.(filePath);
    // Mark-as-viewed also collapses (legacy behavior); un-viewing leaves it.
    // collapseItem bumps the version + updateItem so the header re-renders to
    // the viewed state. Un-viewing performs no collapse, so it would otherwise
    // skip the version bump and leave the (now stale) Viewed badge on screen —
    // force a header refresh so the Viewed button reverts both ways.
    if (!wasViewed) {
      collapseItem(itemId);
    } else {
      refreshItem(itemId);
    }
  });

  const handleFileComment = useStableCallback((filePath: string, anchorEl: HTMLElement) => {
    fileCommentButtonRefs.current.set(filePath, anchorEl);
    setFileCommentAnchor({ el: anchorEl, filePath });
  });

  // Header chrome (Viewed badge, staging spinner / Added checkmark, stage-error
  // text) is driven by external React props, but the custom header is rendered
  // into Pierre's slot portal which only republishes on updateItem — never when
  // a stable render callback's captured props change. So whenever any of those
  // header-driving props change, force a re-render of every affected item.
  //
  // Direct paths (the `a` key and the header Git Add button both call
  // onStage(filePath) without bumping any version; the header Viewed button's
  // un-view branch likewise) are all covered here, so the header stays in sync
  // regardless of which surface triggered the change. We track the previous
  // snapshots (declared with the other refs above) and refresh exactly the
  // items whose state actually changed.
  useEffect(() => {
    const handle = viewerRef.current;
    if (handle == null) {
      // Update snapshots even when no viewer is mounted yet so the first real
      // diff doesn't refresh everything spuriously.
      prevViewedRef.current = viewedFiles;
      prevStagedRef.current = stagedFiles;
      prevStagingRef.current = stagingFile;
      prevStageErrorRef.current = stageError;
      return;
    }

    const changedPaths = new Set<string>();
    const collectSetDelta = (
      next: Set<string> | undefined,
      prev: Set<string> | undefined,
    ) => {
      if (next === prev) return;
      next?.forEach((p) => {
        if (!prev?.has(p)) changedPaths.add(p);
      });
      prev?.forEach((p) => {
        if (!next?.has(p)) changedPaths.add(p);
      });
    };

    collectSetDelta(viewedFiles, prevViewedRef.current);
    collectSetDelta(stagedFiles, prevStagedRef.current);
    // stagingFile / stageError are single-file scalars: the file that just
    // started/stopped staging (or whose error appeared/cleared) needs a refresh.
    if (stagingFile !== prevStagingRef.current) {
      if (stagingFile) changedPaths.add(stagingFile);
      if (prevStagingRef.current) changedPaths.add(prevStagingRef.current);
    }
    if (stageError !== prevStageErrorRef.current) {
      // stageError is shown on the file currently/last staging, so refresh that
      // file in both the appear and clear directions.
      if (stagingFile) changedPaths.add(stagingFile);
      if (prevStagingRef.current) changedPaths.add(prevStagingRef.current);
    }

    prevViewedRef.current = viewedFiles;
    prevStagedRef.current = stagedFiles;
    prevStagingRef.current = stagingFile;
    prevStageErrorRef.current = stageError;

    for (const path of changedPaths) {
      const itemId = filePathToItemId.get(path);
      if (itemId != null) refreshItem(itemId);
    }
  }, [viewedFiles, stagedFiles, stagingFile, stageError, filePathToItemId, refreshItem]);

  // --- Line selection through CodeView (replaces geometry-based inference) ---

  const handleSelectedLinesChange = useStableCallback(
    (selection: CodeViewLineSelection | null) => {
      setSelectedLines(selection);
      onLineSelection(selection ? selection.range : null);
    },
  );

  const handleLineSelectionEnd = useStableCallback(
    (range: SelectedLineRange | null, item: CodeViewItem<undefined>) => {
      if (range == null || item.type !== 'diff') return;
      const filePath = itemIdToFilePath.get(item.id);
      if (filePath == null) return;
      routeSelectionToToolbar(range, filePath);
    },
  );

  const handleGutterUtilityClick = useStableCallback(
    (range: SelectedLineRange, item: CodeViewItem<undefined>) => {
      if (item.type !== 'diff') return;
      const filePath = itemIdToFilePath.get(item.id);
      if (filePath == null) return;
      routeSelectionToToolbar(range, filePath);
    },
  );

  // --- Active-file tracking via CodeView rendered items (no header geometry) ---

  const reportVisibleFile = useStableCallback(() => {
    const viewer = viewerRef.current?.getInstance();
    if (viewer == null) return;
    const rendered = viewer.getRenderedItems();
    if (rendered.length === 0) return;
    const scrollTop = viewer.getScrollTop();
    // The active file is the last rendered item whose top is at or above the
    // current scroll position (with a small threshold), i.e. the file the user
    // is currently reading. Falls back to the first rendered item.
    let bestId = rendered[0].id;
    for (const renderedItem of rendered) {
      const top = viewer.getTopForItem(renderedItem.id);
      if (top == null) continue;
      if (top <= scrollTop + 50) bestId = renderedItem.id;
    }
    const path = itemIdToFilePath.get(bestId) ?? null;
    if (path !== visibleFileRef.current) {
      visibleFileRef.current = path;
      onVisibleFileChange?.(path);
    }
  });

  const handleScroll = useStableCallback(() => {
    reportVisibleFile();
  });

  // CodeView's onScroll only fires on actual scroll, so seed the initial
  // active-file highlight once the viewer has rendered its first window. rAF
  // gives CodeView a frame to mount + measure before we read rendered items.
  // Re-runs on `fileSetKey` because a diff switch remounts CodeView, so the
  // new diff's first file must be re-reported as the active file.
  useEffect(() => {
    const raf = requestAnimationFrame(() => reportVisibleFile());
    return () => cancelAnimationFrame(raf);
  }, [reportVisibleFile, fileSetKey]);

  // --- [/]/z/v/a/c/x navigation + header actions driven by CodeView ----------

  const scrollToItem = useCallback((itemId: string) => {
    const viewer = viewerRef.current;
    if (viewer == null) return;
    viewer.scrollTo({ type: 'item', id: itemId, align: 'start' });
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (orderedItemIds.length === 0) return;

      // The item the user is currently reading (active-file tracking).
      const currentId = visibleFileRef.current
        ? filePathToItemId.get(visibleFileRef.current) ?? null
        : null;
      const currentPath = currentId ? itemIdToFilePath.get(currentId) ?? null : null;

      // x — collapse/expand the current file.
      if (e.key === 'x' && currentId) {
        e.preventDefault();
        toggleItemCollapsed(currentId);
        return;
      }

      // z — re-expand + scroll to the most recently collapsed-and-still-collapsed
      // file (walk the visual order backward from the current position is not how
      // legacy worked; legacy used a collapse history stack). We approximate with
      // the nearest collapsed item before the current one, falling back to the
      // first collapsed item.
      if (e.key === 'z') {
        const collapsedIds = orderedItemIds.filter((id) => isItemCollapsed(id));
        if (collapsedIds.length === 0) return;
        e.preventDefault();
        const target = collapsedIds[collapsedIds.length - 1];
        toggleItemCollapsed(target);
        scrollToItem(target);
        return;
      }

      // c — open the file-scoped comment popover for the current file.
      if (e.key === 'c' && currentPath && onAddFileCommentForFile) {
        e.preventDefault();
        const btn = fileCommentButtonRefs.current.get(currentPath);
        if (btn) setFileCommentAnchor({ el: btn, filePath: currentPath });
        return;
      }

      // v — toggle viewed (and collapse on mark-viewed) for the current file.
      if (e.key === 'v' && currentPath && currentId) {
        e.preventDefault();
        handleToggleViewedAndCollapse(currentPath, currentId);
        return;
      }

      // a — stage/unstage the current file.
      if (e.key === 'a' && currentPath && canStageFiles) {
        e.preventDefault();
        onStage?.(currentPath);
        return;
      }

      if (e.key !== '[' && e.key !== ']') return;
      e.preventDefault();

      const currentIdx = currentId ? orderedItemIds.indexOf(currentId) : -1;
      let targetIdx: number;
      if (e.key === ']') {
        targetIdx = currentIdx < orderedItemIds.length - 1 ? currentIdx + 1 : orderedItemIds.length - 1;
      } else {
        targetIdx = currentIdx > 0 ? currentIdx - 1 : 0;
      }

      scrollToItem(orderedItemIds[targetIdx]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    isActive,
    orderedItemIds,
    filePathToItemId,
    itemIdToFilePath,
    scrollToItem,
    toggleItemCollapsed,
    isItemCollapsed,
    onAddFileCommentForFile,
    handleToggleViewedAndCollapse,
    canStageFiles,
    onStage,
  ]);

  // --- Custom header render slot (the full Plannotator FileHeader) -----------

  const renderCustomHeader = useStableCallback((item: CodeViewItem<undefined>) => {
    if (item.type !== 'diff') return null;
    const filePath = itemIdToFilePath.get(item.id);
    if (filePath == null) return null;
    const file = files.find((f) => f.path === filePath);
    if (file == null) return null;

    const collapsed = item.collapsed === true;

    return (
      <FileHeader
        filePath={filePath}
        patch={file.patch}
        isViewed={viewedFiles?.has(filePath)}
        onToggleViewed={onToggleViewed ? () => handleToggleViewedAndCollapse(filePath, item.id) : undefined}
        isStaged={stagedFiles?.has(filePath)}
        isStaging={stagingFile === filePath}
        onStage={onStage ? () => onStage(filePath) : undefined}
        canStage={canStageFiles}
        stageError={stagingFile === filePath ? stageError : null}
        onFileComment={onAddFileCommentForFile ? (anchorEl) => handleFileComment(filePath, anchorEl) : undefined}
        collapseToggle={
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleItemCollapsed(item.id);
            }}
            className="flex items-center justify-center w-6 h-6 rounded hover:bg-foreground/10 transition-colors flex-shrink-0"
            title={collapsed ? 'Expand diff' : 'Collapse diff'}
          >
            <svg
              className={`w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-90'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        }
        onCollapseToggle={() => toggleItemCollapsed(item.id)}
      />
    );
  });

  // Pass-through allowlist only (CODE_VIEW_DIFF_OPTION_KEYS). hunkSeparators,
  // stickyHeaders, itemMetrics, and the selection callbacks are CodeView-level
  // options. The selection/gutter callbacks receive a context whose `.item` is
  // the owning CodeViewItem, which is how file identity flows without geometry
  // inference. itemMetrics must reflect the custom header height and the
  // unsafeCSS-customized hunk separator height (see constants above), otherwise
  // CodeView's virtualization estimate drifts.
  const options = useMemo<CodeViewOptions<undefined>>(
    () => ({
      themeType: pierreTheme.type,
      unsafeCSS: pierreTheme.css,
      ...(pierreTheme.syntaxTheme && { theme: pierreTheme.syntaxTheme }),
      diffStyle,
      overflow: diffOverflow,
      diffIndicators,
      lineDiffType,
      disableLineNumbers,
      disableBackground,
      expandUnchanged,
      enableLineSelection: true,
      enableGutterUtility: true,
      hunkSeparators: 'line-info',
      stickyHeaders: true,
      itemMetrics: {
        diffHeaderHeight: PANEL_HEADER_HEIGHT,
        hunkSeparatorHeight: HUNK_SEPARATOR_HEIGHT,
      },
      onLineSelectionEnd(range, context) {
        handleLineSelectionEnd(range, context.item);
      },
      onGutterUtilityClick(range, context) {
        handleGutterUtilityClick(range, context.item);
      },
    }),
    [
      pierreTheme.type,
      pierreTheme.css,
      pierreTheme.syntaxTheme,
      diffStyle,
      diffOverflow,
      diffIndicators,
      lineDiffType,
      disableLineNumbers,
      disableBackground,
      expandUnchanged,
      handleLineSelectionEnd,
      handleGutterUtilityClick,
    ],
  );

  return (
    <>
      <CodeView<undefined>
        // Remount on diff switch so uncontrolled `initialItems` re-seeds from
        // the freshly computed identity. Without this, switching diff
        // type/base/whitespace/PR with the all-files panel open would keep the
        // OLD diff on screen (the panel instance is reused, not recreated).
        key={fileSetKey}
        ref={viewerRef}
        containerRef={scrollRef}
        className="h-full overflow-auto"
        initialItems={identity.items}
        options={options}
        selectedLines={selectedLines}
        onSelectedLinesChange={handleSelectedLinesChange}
        onScroll={handleScroll}
        renderCustomHeader={renderCustomHeader}
      />

      <ToolbarHost
        ref={toolbarHostRef}
        patch={activePatch}
        filePath={activeFilePath ?? ''}
        isFocused={true}
        onLineSelection={onLineSelection}
        onAddAnnotation={handleAddAnnotation}
        onEditAnnotation={onEditAnnotation}
        aiAvailable={aiAvailable}
        onAskAI={onAskAI}
        isAILoading={isAILoading}
        onViewAIResponse={onViewAIResponse}
        aiHistoryMessages={aiHistoryForSelection}
      />

      {fileCommentAnchor && onAddFileCommentForFile && (
        <CommentPopover
          key={`file:${prUrl ?? ''}:${prDiffScope ?? ''}:${fileCommentAnchor.filePath}`}
          anchorEl={fileCommentAnchor.el}
          contextText={fileCommentAnchor.filePath.split('/').pop() || fileCommentAnchor.filePath}
          isGlobal={false}
          draftKey={`file:${prUrl ?? ''}:${prDiffScope ?? ''}:${fileCommentAnchor.filePath}`}
          onSubmit={(text) => {
            onAddFileCommentForFile(fileCommentAnchor.filePath, text);
            setFileCommentAnchor(null);
          }}
          onClose={() => setFileCommentAnchor(null)}
        />
      )}
    </>
  );
};
