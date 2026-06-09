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
import { usePierreTheme } from '../hooks/usePierreTheme';
import type { DiffFile } from '../types';
import { buildFileTree, getVisualFileOrder } from '../utils/buildFileTree';
import { ToolbarHost, type ToolbarHostHandle } from './ToolbarHost';
import type { AIChatEntry } from '../hooks/useAIChat';

/**
 * AllFilesCodeView (migration phases P1 + P2)
 *
 * Renders every changed file through ONE Pierre `CodeView` inside a single
 * scroll container, replacing the legacy per-file `FileDiff` list
 * (`AllFilesDiffView`). Gated behind the `allFilesCodeView` config flag.
 *
 * P1 established the static, uncontrolled `initialItems` skeleton with the
 * built-in Pierre header. P2 locks down item identity and routes navigation +
 * line selection through CodeView's own APIs:
 *
 *  - Stable, path-based item ids. Workspace-prefixed paths are kept intact
 *    (server /api/file-content & /api/git-add resolve them). Duplicate / repeated
 *    paths in the raw patch get a Diffshub-style collision suffix so two files
 *    never collapse into one item; a filePath <-> itemId map keeps the bridge.
 *  - File-tree-style navigation through `viewer.scrollTo({ type: 'item' })`
 *    rather than header `scrollIntoView`. `[`/`]` step between files and `z`
 *    un-collapses the most recent jump — all driven by CodeView positioning.
 *  - Active-file highlight derived from CodeView rendered-item tracking
 *    (`onScroll` + `getRenderedItems`), not external header geometry, and
 *    reported up via `onVisibleFileChange`.
 *  - Line selection through `onLineSelectionEnd` / `onSelectedLinesChange`. The
 *    owning file comes from `context.item.id`, replacing the legacy
 *    header-geometry file inference. The toolbar is fed file identity from that
 *    callback context, not from an `activeFilePath` side channel.
 *
 * Annotations rendering, full-content hunk expansion, the rich custom header,
 * collapse, search highlighting, and the worker pool remain later phases.
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
  // File-tree active-file highlight follows scroll.
  onVisibleFileChange?: (filePath: string | null) => void;
  // Only handle [/]/z keyboard nav when this surface is the active panel.
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
  onVisibleFileChange,
  isActive = true,
  aiAvailable = false,
  onAskAI,
  isAILoading = false,
  onViewAIResponse,
  aiHistoryForSelection = [],
}) => {
  // showFileHeader: true keeps Pierre's built-in header title visible (see P1
  // note) — this surface relies on the built-in header to label each file.
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
  // selection / active-file state so nothing keys off a file from the old diff.
  useEffect(() => {
    setActiveFilePath(null);
    setSelectedLines(null);
    pendingToolbarRange.current = null;
    visibleFileRef.current = null;
  }, [fileSetKey]);

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

  // --- [/] and z navigation driven by CodeView positioning ---

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

      if (e.key !== '[' && e.key !== ']') return;
      if (orderedItemIds.length === 0) return;
      e.preventDefault();

      // Anchor stepping on whatever file CodeView currently considers visible.
      const currentId = visibleFileRef.current
        ? filePathToItemId.get(visibleFileRef.current) ?? null
        : null;
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
  }, [isActive, orderedItemIds, filePathToItemId, scrollToItem]);

  // Pass-through allowlist only (CODE_VIEW_DIFF_OPTION_KEYS). hunkSeparators,
  // stickyHeaders, and the selection callbacks are CodeView-level options. The
  // selection/gutter callbacks receive a context whose `.item` is the owning
  // CodeViewItem, which is how file identity flows without geometry inference.
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
    </>
  );
};
