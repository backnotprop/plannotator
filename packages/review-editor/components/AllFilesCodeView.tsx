import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSingularPatch, processFile } from '@pierre/diffs';
import type {
  CodeViewItem,
  CodeViewLineSelection,
  CodeViewOptions,
  DiffLineAnnotation,
  FileDiffMetadata,
  LineAnnotation,
  PostRenderPhase,
  SelectedLineRange,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import type { DiffTokenEventBaseProps } from '@pierre/diffs';
import type {
  CodeAnnotation,
  CodeAnnotationType,
  ConventionalDecoration,
  ConventionalLabel,
  DiffAnnotationMetadata,
  TokenAnnotationMeta,
} from '@plannotator/ui/types';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { storage } from '@plannotator/ui/utils/storage';
import { usePierreTheme } from '../hooks/usePierreTheme';
import type { DiffFile } from '../types';
import { buildFileTree, getVisualFileOrder } from '../utils/buildFileTree';
import { buildCodeNavRequest } from '../utils/buildCodeNavRequest';
import { ToolbarHost, type ToolbarHostHandle } from './ToolbarHost';
import { FileHeader } from './FileHeader';
import { InlineAnnotation } from './InlineAnnotation';
import { detectLanguage } from '../utils/detectLanguage';
import type { AIChatEntry } from '../hooks/useAIChat';
import type { ReviewSearchMatch } from '../utils/reviewSearch';
import {
  applyItemSearchHighlights,
  clearItemSearchHighlights,
  swapActiveSearchHighlight,
} from '../utils/reviewSearchHighlight';

/**
 * AllFilesCodeView (migration phases P1 + P2 + P3 + P4)
 *
 * Renders every changed file through ONE Pierre `CodeView` inside a single
 * scroll container, replacing the legacy per-file `FileDiff` list
 * (`AllFilesDiffView`). Gated behind the `allFilesCodeView` config flag.
 *
 * P1 established the static, uncontrolled `initialItems` skeleton. P2 locked
 * down item identity and routed navigation + line selection through CodeView's
 * own APIs. P3 moved collapse + the full Plannotator FileHeader INTO CodeView
 * via the `renderCustomHeader` render slot.
 *
 * P4 (this phase) routes annotations through CodeView item state:
 *
 *  - CodeView is typed with `<DiffAnnotationMetadata>` so each diff item's
 *    `annotations: DiffLineAnnotation<DiffAnnotationMetadata>[]` and
 *    `renderAnnotation(annotation, item)` are fully typed.
 *  - Annotations are grouped per file (the same projection AllFilesDiffView
 *    builds: side 'additions'/'deletions', lineNumber = ann.lineEnd, metadata =
 *    DiffAnnotationMetadata) and seeded onto each item at build time. When the
 *    `annotations` prop changes we rebuild ONLY the affected items' annotation
 *    arrays, bump `item.version`, and call `viewer.updateItem(item)` — so a
 *    single annotation add/edit/delete re-renders just its owning file.
 *  - `renderAnnotation` renders the existing `InlineAnnotation` from
 *    `annotation.metadata`, routing onSelect/onEdit/onDelete by the OWNING item
 *    (no active-file side channel). Edit routes through the ToolbarHost handle.
 *  - Selecting an annotation in the sidebar expands its owning file
 *    (item.collapsed=false + version bump + updateItem) and
 *    `scrollTo({ type: 'item' | 'range' })` to it.
 *  - The annotation toolbar already flows through CodeView's
 *    `onGutterUtilityClick` / `onLineSelectionEnd` callbacks (P2): file identity
 *    comes from `context.item.id`, and ToolbarHost is fed that file's patch so
 *    original-code extraction reads the correct file. Drafts-by-file/range and
 *    AI markers are preserved by ToolbarHost/useAnnotationToolbar unchanged.
 *
 * P5 (this phase) preserves lazy full-content hunk expansion through CodeView
 * item updates instead of LazyFileDiff's per-mount IntersectionObserver fetch:
 *
 *  - Initial items use `getSingularPatch` (raw-patch context only) — CodeView
 *    already virtualizes the visible window, so no full content is fetched up
 *    front.
 *  - When an item enters CodeView's rendered window (its `onPostRender` fires
 *    with phase 'mount'/'update', the direct analogue of LazyFileDiff's
 *    IntersectionObserver becoming visible), we fetch `/api/file-content` for
 *    that file (path/oldPath preserved — workspace prefixes intact — plus the
 *    review base), reparse with `processFile`, and swap `item.fileDiff` to the
 *    augmented `FileDiffMetadata`. The augmented diff gets a NEW `cacheKey`
 *    (contents changed!), `item.version++`, and `viewer.updateItem(item)`. This
 *    enables the gutter's expand-unchanged controls in place, without
 *    remounting the list.
 *  - CodeView's `updateItem` re-measures the grown item and resolves the
 *    captured scroll anchor, so the viewport stays put whether the augmented
 *    item is above OR below the fold.
 *  - Fetches are guarded (one per item) and cancellable (AbortController per
 *    item, all aborted on unmount / diff switch), so there is no fetch storm and
 *    no double-fetch. LazyFileDiff is no longer on the CodeView path (it remains
 *    only for the legacy flag-off AllFilesDiffView).
 *
 * P6 (this phase) makes search work over CodeView's recycled DOM:
 *
 *  - The raw-patch search INDEX is unchanged (App still owns useReviewSearch).
 *    Only DOM application + navigation move here for the all-files surface.
 *  - Navigation: when an active match changes, expand its owning file (if
 *    collapsed) and `viewer.scrollTo({ type: 'line', id, lineNumber, side })` so
 *    the line lands in view — robust against virtualization (no DOM dependency).
 *  - Highlighting survives element recycling by re-applying `<mark>` per ITEM via
 *    `onPostRender`: on mount/update we (re)apply that item's matches; on unmount
 *    we clear its marks. CodeView reuses item elements from a pool, so a one-shot
 *    mutation would stick to a reused row or vanish — re-applying on every render
 *    keeps marks correct after scrolling far enough to recycle. A separate effect
 *    re-applies across all currently-rendered items when the query/matches change
 *    (no render is otherwise triggered), and an O(1) effect swaps just the active
 *    match's styling when stepping between matches.
 *
 * P7 (this phase) finishes the edges so CodeView can be the DEFAULT all-files
 * renderer (the `allFilesCodeView` flag now defaults ON):
 *
 *  - Center split dragger: the legacy single-file DiffViewer owns a per-file
 *    split dragger; the legacy all-files view had none. With one CodeView
 *    container we add a single dragger here. The `--split-left` / `--split-right`
 *    CSS variables are set on the CodeView CONTAINER (light DOM) — they inherit
 *    through every item's shadow root, so the existing usePierreTheme grid rule
 *    (`[data-diff-type='split'][data-overflow='scroll']`) resizes every split
 *    file's two columns uniformly. The drag overlay is a single vertical line
 *    pinned to the container at `splitRatio` of its width; because it is
 *    positioned relative to the (non-virtualized) container — not to any
 *    individual item — it is unaffected by virtualization, sticky headers, or
 *    CodeView's 12M-px paged scroll rebasing. Only shown in split + scroll mode.
 *  - Token code navigation: Cmd/Ctrl-click a token routes through
 *    `onCodeNavRequest` (parity with the single-file DiffViewer and the legacy
 *    all-files view), with `pn-token-hover` / `pn-token-nav` affordances. File
 *    identity comes from the CodeView callback context's owning item, never an
 *    active-file side channel.
 *  - Safari scroll guardian: NOT carried forward. The old DiffViewer guardian
 *    targeted the OverlayScrollbars viewport wrapping many separate FileDiff
 *    shadow nodes and restored scrollTop on a ">200 -> 0" jump heuristic.
 *    CodeView owns its own scroll model and DELIBERATELY rebases the container's
 *    DOM scrollTop into a bounded 12M-px paged window, so that heuristic would
 *    misfire against CodeView's own rebasing. CodeView is the scroll authority
 *    here; we rely on it rather than a guardian that would fight it. (See the
 *    known-gaps note — needs real WebKit validation before legacy removal.)
 *
 * The worker pool remains a later phase.
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
  // Annotation state (P4). Mirrors AllFilesDiffView's annotation surface so
  // line annotations render through CodeView item state.
  annotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  pendingSelection: SelectedLineRange | null;
  reviewBase?: string;
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
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
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
  // Search (P6). The raw-patch index lives in App (useReviewSearch); these feed
  // the per-item <mark> application + scrollTo navigation over the recycled DOM.
  searchQuery?: string;
  searchMatches?: ReviewSearchMatch[];
  activeSearchMatchId?: string | null;
  activeSearchMatch?: ReviewSearchMatch | null;
  // Token code navigation (P7). Cmd/Ctrl-click a token resolves symbol defs/refs.
  onCodeNavRequest?: (request: import('@plannotator/shared/code-nav').CodeNavRequest) => void;
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
  items: CodeViewItem<DiffAnnotationMetadata>[];
  /** Maps a file path to the CodeView item id that owns it. */
  filePathToItemId: Map<string, string>;
  /** Maps a CodeView item id back to the originating file path. */
  itemIdToFilePath: Map<string, string>;
  /** Maps a CodeView item id to its originating DiffFile. Keyed by the unique
   * item id (not path) so duplicate display paths resolve to the correct file. */
  itemIdToFile: Map<string, DiffFile>;
}

// Project a file's line annotations into Pierre's DiffLineAnnotation shape. This
// is the EXACT projection AllFilesDiffView builds (side, lineNumber = lineEnd,
// metadata = DiffAnnotationMetadata) so the two surfaces render identically.
// Filters to line-scoped annotations that belong to this file in the active
// PR/diff-scope (file-scoped comments live in the header, not the gutter).
function projectFileAnnotations(
  annotations: CodeAnnotation[],
  filePath: string,
  prUrl: string | undefined,
  prDiffScope: string | undefined,
): DiffLineAnnotation<DiffAnnotationMetadata>[] {
  return annotations
    .filter(
      (a) =>
        a.filePath === filePath &&
        (a.scope ?? 'line') === 'line' &&
        (!a.prUrl || !prUrl || a.prUrl === prUrl) &&
        (!a.diffScope || !prDiffScope || a.diffScope === prDiffScope),
    )
    .map((ann) => ({
      side: ann.side === 'new' ? ('additions' as const) : ('deletions' as const),
      lineNumber: ann.lineEnd,
      metadata: {
        annotationId: ann.id,
        type: ann.type,
        text: ann.text,
        suggestedCode: ann.suggestedCode,
        originalCode: ann.originalCode,
        author: ann.author,
        severity: ann.severity,
        reasoning: ann.reasoning,
        conventionalLabel: ann.conventionalLabel,
        decorations: ann.decorations,
      } as DiffAnnotationMetadata,
    }));
}

function buildItemIdentity(
  files: DiffFile[],
  visualOrder: number[],
  annotations: CodeAnnotation[],
  prUrl: string | undefined,
  prDiffScope: string | undefined,
): ItemIdentity {
  const items: CodeViewItem<DiffAnnotationMetadata>[] = [];
  const filePathToItemId = new Map<string, string>();
  const itemIdToFilePath = new Map<string, string>();
  const itemIdToFile = new Map<string, DiffFile>();
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
    // Seed annotations at build time so the first render (and any remount via
    // fileSetKey) already paints existing annotations without an extra update.
    const fileAnnotations = projectFileAnnotations(annotations, file.path, prUrl, prDiffScope);
    items.push({ id, type: 'diff', fileDiff, version: 0, annotations: fileAnnotations });
    // First occurrence of a path wins the canonical lookup so the file tree
    // (keyed by path) navigates to the primary item for that path.
    if (!filePathToItemId.has(file.path)) {
      filePathToItemId.set(file.path, id);
    }
    itemIdToFilePath.set(id, file.path);
    itemIdToFile.set(id, file);
  }

  return { items, filePathToItemId, itemIdToFilePath, itemIdToFile };
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
  annotations,
  selectedAnnotationId,
  pendingSelection,
  reviewBase,
  onLineSelection,
  onAddAnnotationForFile,
  onEditAnnotation,
  onSelectAnnotation,
  onDeleteAnnotation,
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
  searchQuery = '',
  searchMatches = [],
  activeSearchMatchId = null,
  activeSearchMatch = null,
  onCodeNavRequest,
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
  const viewerRef = useRef<CodeViewHandle<DiffAnnotationMetadata> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolbarHostRef = useRef<ToolbarHostHandle>(null);

  // --- Center split dragger (P7) ----------------------------------------------
  // One dragger for the whole CodeView container. `--split-left` / `--split-right`
  // are written on the container (light DOM); they inherit through every item's
  // shadow root so usePierreTheme's split-grid rule resizes all split files'
  // columns together. Shares the `review-split-ratio` storage key with the
  // single-file DiffViewer so the chosen ratio is consistent across surfaces.
  const showSplitDragger = diffStyle === 'split' && diffOverflow !== 'wrap';
  const [splitRatio, setSplitRatio] = useState(() => {
    const saved = storage.getItem('review-split-ratio');
    const n = saved ? Number(saved) : NaN;
    return !Number.isNaN(n) && n >= 0.2 && n <= 0.8 ? n : 0.5;
  });
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);

  const handleSplitDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const container = scrollRef.current;
    if (container == null) return;
    setIsDraggingSplit(true);

    const onMove = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (moveEvent.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
    };
    const onUp = () => {
      setIsDraggingSplit(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      storage.setItem('review-split-ratio', String(splitRatioRef.current));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, []);

  const resetSplitRatio = useCallback(() => {
    setSplitRatio(0.5);
    storage.setItem('review-split-ratio', '0.5');
  }, []);

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
  // Previous annotations snapshot for the per-item annotation-sync effect (P4).
  const prevAnnotationsRef = useRef<CodeAnnotation[]>(annotations);

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
  // NOTE: `annotations` is intentionally NOT in the dep list. The identity (and
  // the CodeView remount it drives via fileSetKey) must only change when the
  // FILE SET changes — otherwise every annotation add/edit/delete would remount
  // the whole CodeView and lose scroll/selection state. Existing annotations are
  // seeded into items on (re)build via the captured `annotations` closure for
  // the first paint; subsequent annotation changes are applied incrementally per
  // item by the annotation-sync effect below (updateItem on only the changed
  // file). We read the latest annotations through a ref at build time so a
  // remount triggered by a file-set change still seeds current annotations.
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const identity = useMemo<ItemIdentity>(
    () => buildItemIdentity(files, visualOrder, annotationsRef.current, prUrl, prDiffScope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, visualOrder, prUrl, prDiffScope],
  );
  const { filePathToItemId, itemIdToFilePath, itemIdToFile } = identity;

  // Stable identity of the current diff. Changes whenever the file set or any
  // file's patch content changes (diff type / base / whitespace / PR switch),
  // and is used as the CodeView `key` to force a remount + fresh seed. Path +
  // patch length is a cheap proxy for "the diff changed" without hashing every
  // byte of every patch.
  const fileSetKey = useMemo(
    () => `${files.length}:${files.map((f) => `${f.path}#${f.patch.length}`).join('|')}`,
    [files],
  );

  // Push the split ratio onto the container as CSS vars (P7). Setting them on the
  // scroll container (not per item) is what lets the vars inherit into every
  // item's shadow DOM where usePierreTheme's split-grid rule lives. Cleared when
  // not in split+scroll mode so unified / wrap fall back to Pierre's default 1fr
  // columns. Re-runs on fileSetKey because the CodeView remount recreates the
  // container element, dropping any previously-set inline vars.
  useEffect(() => {
    const el = scrollRef.current;
    if (el == null) return;
    if (showSplitDragger) {
      el.style.setProperty('--split-left', `${splitRatio}fr`);
      el.style.setProperty('--split-right', `${1 - splitRatio}fr`);
    } else {
      el.style.removeProperty('--split-left');
      el.style.removeProperty('--split-right');
    }
  }, [showSplitDragger, splitRatio, fileSetKey]);

  // Visual-order list of file paths (for [/] stepping). Derived from items so it
  // matches CodeView's rendered order exactly.
  const orderedItemIds = useMemo(
    () => identity.items.map((item) => item.id),
    [identity.items],
  );

  // Path -> DiffFile lookup for the on-demand content augmentation (P5). The
  // post-render callback resolves item.id -> path -> DiffFile to know which
  // file's patch/oldPath to fetch + reparse.
  const activePatch = useMemo(
    () => (activeFilePath ? files.find((f) => f.path === activeFilePath)?.patch ?? '' : ''),
    [files, activeFilePath],
  );

  // --- Search (P6) ------------------------------------------------------------
  // Group search matches by the CodeView item id that owns the file, so each
  // item's onPostRender (and the bulk reapply effect) can apply ONLY its own
  // matches. Matches are file-keyed (filePath); resolve to itemId via the bridge.
  const matchesByItemId = useMemo(() => {
    const map = new Map<string, ReviewSearchMatch[]>();
    if (searchMatches.length === 0) return map;
    for (const match of searchMatches) {
      const itemId = filePathToItemId.get(match.filePath);
      if (itemId == null) continue;
      const group = map.get(itemId);
      if (group) group.push(match);
      else map.set(itemId, [match]);
    }
    return map;
  }, [searchMatches, filePathToItemId]);

  // Read search state through refs so the stable onPostRender callback always
  // sees the latest values without changing the CodeView options identity (which
  // would churn the options object and reset CodeView).
  const matchesByItemIdRef = useRef(matchesByItemId);
  matchesByItemIdRef.current = matchesByItemId;
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const activeSearchMatchIdRef = useRef(activeSearchMatchId);
  activeSearchMatchIdRef.current = activeSearchMatchId;

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

  // Edit routes through the ToolbarHost handle (same as AllFilesDiffView). The
  // annotation's id resolves to the full CodeAnnotation so the toolbar opens
  // pre-filled. ToolbarHost is keyed to the active file's patch; startEdit
  // positions itself by last-known mouse position, so it works regardless of
  // which file the clicked annotation belongs to.
  const handleEditAnnotation = useCallback(
    (id: string) => {
      const ann = annotations.find((a) => a.id === id);
      if (!ann) return;
      toolbarHostRef.current?.startEdit(ann);
    },
    [annotations],
  );

  // Render a single annotation from item state. `renderAnnotation` receives both
  // the LineAnnotation and DiffLineAnnotation union — guard `'side' in
  // annotation && item.type === 'diff'` (the Diffshub pattern) so file-item
  // annotations (none here) and metadata-less annotations are skipped. Actions
  // route by the OWNING item, not an active-file side channel.
  const renderAnnotation = useStableCallback(
    (
      annotation:
        | DiffLineAnnotation<DiffAnnotationMetadata>
        | LineAnnotation<DiffAnnotationMetadata>,
      item: CodeViewItem<DiffAnnotationMetadata>,
    ) => {
      if (!('side' in annotation) || item.type !== 'diff') return null;
      if (!annotation.metadata) return null;
      const filePath = itemIdToFilePath.get(item.id);
      return (
        <InlineAnnotation
          metadata={annotation.metadata}
          language={filePath ? detectLanguage(filePath) : undefined}
          onSelect={onSelectAnnotation}
          onEdit={handleEditAnnotation}
          onDelete={onDeleteAnnotation}
        />
      );
    },
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
    // Annotations are seeded into the remounted items at build time, so resync
    // the snapshot here to avoid a spurious full annotation refresh post-remount.
    prevAnnotationsRef.current = annotations;
    // Abort any in-flight content fetches and clear the augmentation guard so
    // the new diff's items re-fetch full content on their first render. (The old
    // items are gone after the fileSetKey remount; their ids may also be reused
    // by the new diff, so the guard must not leak across the switch.)
    for (const { controller } of augmentRef.current.values()) controller.abort();
    augmentRef.current.clear();
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

  // --- Lazy full-content hunk expansion via CodeView item updates (P5) --------

  // Per-item augmentation bookkeeping. `status` guards against double-fetch /
  // fetch storms (an item can re-fire onPostRender on every scroll-driven
  // remount of its element); `controller` lets us abort an in-flight fetch when
  // the diff switches or the component unmounts. Keyed by CodeView item id.
  const augmentRef = useRef<
    Map<string, { status: 'pending' | 'done' | 'error'; controller: AbortController }>
  >(new Map());
  // reviewBase / itemIdToFile read through refs so the stable onPostRender
  // callback always sees the latest values without changing identity (which
  // would otherwise churn the CodeView options object).
  const reviewBaseRef = useRef(reviewBase);
  reviewBaseRef.current = reviewBase;
  const itemIdToFileRef = useRef(itemIdToFile);
  itemIdToFileRef.current = itemIdToFile;

  // Fetch full file contents for one item, reparse with processFile, and swap
  // the item's fileDiff in place so hunk expansion (expand-unchanged gutter
  // controls) works against the COMPLETE file. Mirrors LazyFileDiff's per-mount
  // fetch, but updates the existing CodeView item instead of mounting a fresh
  // FileDiff — so CodeView's own virtualization + element pool stay in charge.
  const augmentItem = useCallback((itemId: string) => {
    const handle = viewerRef.current;
    if (handle == null) return;
    const augmentState = augmentRef.current;
    // One fetch per item: 'pending' or already-resolved means do nothing. (An
    // item re-entering the rendered window re-fires onPostRender, so this guard
    // is what prevents the fetch storm.)
    if (augmentState.has(itemId)) return;

    // Resolve the file by item id (NOT path) so duplicate display paths each
    // augment with their own DiffFile content.
    const file = itemIdToFileRef.current.get(itemId);
    if (file == null) return;

    const controller = new AbortController();
    augmentState.set(itemId, { status: 'pending', controller });

    // Workspace-prefixed paths are passed through verbatim — /api/file-content
    // resolves the prefix back to the owning repo (same contract LazyFileDiff /
    // DiffViewer rely on).
    const params = new URLSearchParams({ path: file.path });
    if (file.oldPath) params.set('oldPath', file.oldPath);
    const base = reviewBaseRef.current;
    if (base) params.set('base', base);

    fetch(`/api/file-content?${params}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { oldContent: string | null; newContent: string | null } | null) => {
        if (!data || (data.oldContent == null && data.newContent == null)) {
          // No content available (e.g. demo mode / binary): mark done so we do
          // not retry on every subsequent render. The raw-patch context still
          // shows; there is just nothing to expand.
          augmentState.set(itemId, { status: 'done', controller });
          return;
        }

        let augmented: FileDiffMetadata;
        try {
          const result = processFile(file.patch, {
            oldFile:
              data.oldContent != null
                ? { name: file.oldPath || file.path, contents: data.oldContent }
                : undefined,
            newFile:
              data.newContent != null ? { name: file.path, contents: data.newContent } : undefined,
          });
          if (!result) {
            augmentState.set(itemId, { status: 'done', controller });
            return;
          }
          augmented = result;
        } catch {
          augmentState.set(itemId, { status: 'error', controller });
          return;
        }

        const liveHandle = viewerRef.current;
        const item = liveHandle?.getItem(itemId);
        // The item may have been torn down (diff switch) between fetch start and
        // resolution; the diff-switch reset clears augmentRef + aborts, so this
        // is a belt-and-suspenders guard.
        if (liveHandle == null || item == null || item.type !== 'diff') {
          augmentState.set(itemId, { status: 'done', controller });
          return;
        }

        // cacheKey MUST change when fileDiff contents change (types.ts warning):
        // otherwise the worker / highlight caches would serve the stale partial
        // AST. Derive a fresh key from the augmented (now full-content) diff.
        augmented.cacheKey = `${itemId}#full`;
        item.fileDiff = augmented;
        item.version = (item.version ?? 0) + 1;
        // updateItem re-measures the (now taller) item and resolves the captured
        // scroll anchor, so the viewport stays put whether this item is above or
        // below the fold — no manual scroll correction needed.
        liveHandle.updateItem(item);
        augmentState.set(itemId, { status: 'done', controller });
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          // Aborted (unmount / diff switch): drop the entry so a future render of
          // the same id can re-fetch if needed.
          augmentState.delete(itemId);
          return;
        }
        augmentState.set(itemId, { status: 'error', controller });
        void err;
      });
  }, []);

  // (Re)apply search marks for ONE item's node. Called on every render of that
  // item (onPostRender mount/update) so marks survive CodeView's element
  // recycling — a recycled element is cleared and re-marked for whatever file it
  // now shows. `node` is the item's `<diffs-container>` element. Reads search
  // state through refs so the stable onPostRender callback stays identity-stable.
  const applyItemHighlights = useCallback((node: HTMLElement, itemId: string) => {
    const matches = matchesByItemIdRef.current.get(itemId) ?? [];
    applyItemSearchHighlights(node, searchQueryRef.current, matches, activeSearchMatchIdRef.current);
  }, []);

  // CodeView fires onPostRender for an item whenever it enters / updates within
  // the rendered window. Phase 'mount' (and 'update' for the first paint of a
  // freshly-seeded item) is the direct analogue of LazyFileDiff's
  // IntersectionObserver firing — so we trigger augmentation there. We ride
  // CodeView's existing virtualization rather than layering our own observer on
  // top (which would double-virtualize and fight the element pool).
  //
  // P6: the same per-item render cycle drives search-mark reconciliation. On
  // mount/update we (re)apply this item's marks (defends against recycling); on
  // unmount we clear them so a future reuse of the element starts clean. Marks
  // are reapplied via rAF so they land after CodeView has (re)written the item's
  // line DOM for this render — applying synchronously here could mark a tree
  // that's about to be overwritten.
  const handlePostRender = useStableCallback(
    (
      node: HTMLElement,
      _instance: unknown,
      phase: PostRenderPhase,
      context: CodeViewItem<DiffAnnotationMetadata>,
    ) => {
      if (context.type !== 'diff') return;
      if (phase === 'unmount') {
        clearItemSearchHighlights(node);
        return;
      }
      augmentItem(context.id);
      const itemId = context.id;
      requestAnimationFrame(() => applyItemHighlights(node, itemId));
    },
  );

  // Abort all in-flight content fetches on unmount.
  useEffect(() => {
    const augmentState = augmentRef.current;
    return () => {
      for (const { controller } of augmentState.values()) controller.abort();
      augmentState.clear();
    };
  }, []);

  // When the query or the match set changes (but no item re-render is triggered),
  // re-apply marks across every currently-rendered item. onPostRender only fires
  // when an item mounts/updates/recycles, so a pure query change wouldn't repaint
  // existing rows without this. We read live rendered items from the viewer (each
  // carries its `<diffs-container>` element) and apply each item's own matches.
  // rAF defers one frame so any pending CodeView render settles first.
  useEffect(() => {
    const handle = viewerRef.current;
    if (handle == null) return;
    const raf = requestAnimationFrame(() => {
      const viewer = viewerRef.current?.getInstance();
      if (viewer == null) return;
      for (const rendered of viewer.getRenderedItems()) {
        if (rendered.type !== 'diff' || rendered.element == null) continue;
        applyItemHighlights(rendered.element, rendered.id);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [searchQuery, matchesByItemId, applyItemHighlights]);

  // O(1) active-match swap when stepping between matches: recolor just the
  // previously-active and newly-active marks across the whole container instead
  // of rebuilding every item's marks. Mirrors DiffViewer's swap effect.
  useEffect(() => {
    const container = scrollRef.current;
    if (container == null) return;
    swapActiveSearchHighlight(container, activeSearchMatchId);
  }, [activeSearchMatchId]);

  // Navigate to the active match: expand its owning file (if collapsed) and
  // scrollTo the line. scrollTo is DOM-independent (resolves the line top from
  // CodeView's layout model), so it works even when the target row is far
  // outside the rendered window — the line's marks then paint via onPostRender as
  // CodeView renders the row. rAF defers the scroll one frame so an expand's
  // layout settles before resolving the line top.
  useEffect(() => {
    if (activeSearchMatch == null) return;
    const itemId = filePathToItemId.get(activeSearchMatch.filePath);
    if (itemId == null) return;
    const handle = viewerRef.current;
    if (handle == null) return;

    const item = handle.getItem(itemId);
    if (item != null && item.collapsed === true) {
      item.collapsed = false;
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
    }

    // ReviewSearchSide: 'addition' -> additions, 'deletion' -> deletions,
    // 'context' -> additions (context rows carry the NEW-side line number in the
    // search index, so the additions side resolves the correct row).
    const side: 'additions' | 'deletions' =
      activeSearchMatch.side === 'deletion' ? 'deletions' : 'additions';
    const lineNumber = activeSearchMatch.lineNumber;
    const raf = requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (viewer == null) return;
      viewer.scrollTo({ type: 'line', id: itemId, lineNumber, side, align: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeSearchMatch, filePathToItemId]);

  // --- Annotations through CodeView item state (P4) ---------------------------

  // Set an item's annotations to the current per-file projection, bump version,
  // and updateItem. Mirrors Diffshub's updateViewerDiffItem (getItem, mutate,
  // version++, updateItem) but rebuilds the whole annotation array from the
  // source-of-truth `annotations` rather than splicing a single entry — the diff
  // is computed at the item granularity by the sync effect below, so only files
  // whose annotation set actually changed get an updateItem.
  const syncItemAnnotations = useCallback(
    (filePath: string, itemId: string, allAnnotations: CodeAnnotation[]) => {
      const handle = viewerRef.current;
      const item = handle?.getItem(itemId);
      if (handle == null || item == null || item.type !== 'diff') return;
      item.annotations = projectFileAnnotations(allAnnotations, filePath, prUrl, prDiffScope);
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
    },
    [prUrl, prDiffScope],
  );

  // Whenever the `annotations` prop changes, re-project per file and updateItem
  // ONLY on the files whose annotation set changed (so a single add/edit/delete
  // re-renders just its owning file, never the whole CodeView). Diff is keyed on
  // a per-file annotation signature so unrelated files are untouched. New diffs
  // remount CodeView via fileSetKey and seed annotations at build time, so the
  // diff-switch reset effect resynchronizes prevAnnotationsRef to avoid a
  // spurious full refresh right after a remount.
  useEffect(() => {
    const handle = viewerRef.current;
    const prev = prevAnnotationsRef.current;
    prevAnnotationsRef.current = annotations;
    if (handle == null || prev === annotations) return;

    // Per-file annotation signature: id|line|side|content fingerprint. We only
    // need to know whether a file's gutter annotations changed, so a stable
    // string built from the fields that affect rendering is sufficient and far
    // cheaper than deep-equality of the projected objects.
    const signatures = (list: CodeAnnotation[]) => {
      const map = new Map<string, string>();
      for (const a of list) {
        if ((a.scope ?? 'line') !== 'line') continue;
        if (a.prUrl && prUrl && a.prUrl !== prUrl) continue;
        if (a.diffScope && prDiffScope && a.diffScope !== prDiffScope) continue;
        const sig = JSON.stringify([
          a.id, a.lineEnd, a.side, a.type,
          a.text ?? '', a.suggestedCode ?? '', a.originalCode ?? '',
          a.conventionalLabel ?? '', (a.decorations ?? []).join(','),
          a.severity ?? '', a.reasoning ?? '', a.author ?? '',
        ]);
        map.set(a.filePath, `${map.get(a.filePath) ?? ''}${sig}\n`);
      }
      return map;
    };

    const nextSig = signatures(annotations);
    const prevSig = signatures(prev);
    const changedPaths = new Set<string>();
    nextSig.forEach((sig, path) => {
      if (prevSig.get(path) !== sig) changedPaths.add(path);
    });
    prevSig.forEach((_sig, path) => {
      if (!nextSig.has(path)) changedPaths.add(path);
    });

    for (const path of changedPaths) {
      const itemId = filePathToItemId.get(path);
      if (itemId != null) syncItemAnnotations(path, itemId, annotations);
    }
  }, [annotations, prUrl, prDiffScope, filePathToItemId, syncItemAnnotations]);

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

  // Reflect the App-level `pendingSelection` (the range the toolbar / AI is
  // operating on) as CodeView's highlighted lines on the active file. Mirrors
  // AllFilesDiffView, which passes `pendingSelection` as `selectedLines` to the
  // active file's FileDiff. Scoped by `activeFilePath` so the highlight only
  // paints on the file that owns the selection.
  useEffect(() => {
    if (activeFilePath && pendingSelection) {
      const itemId = filePathToItemId.get(activeFilePath);
      if (itemId != null) {
        setSelectedLines({ id: itemId, range: pendingSelection });
        return;
      }
    }
    // pendingSelection cleared (annotation submitted / cancelled / AI done):
    // drop the highlight instead of leaving it stuck on the file.
    setSelectedLines(null);
  }, [activeFilePath, pendingSelection, filePathToItemId]);

  const handleLineSelectionEnd = useStableCallback(
    (range: SelectedLineRange | null, item: CodeViewItem<DiffAnnotationMetadata>) => {
      if (range == null || item.type !== 'diff') return;
      const filePath = itemIdToFilePath.get(item.id);
      if (filePath == null) return;
      routeSelectionToToolbar(range, filePath);
    },
  );

  const handleGutterUtilityClick = useStableCallback(
    (range: SelectedLineRange, item: CodeViewItem<DiffAnnotationMetadata>) => {
      if (item.type !== 'diff') return;
      const filePath = itemIdToFilePath.get(item.id);
      if (filePath == null) return;
      routeSelectionToToolbar(range, filePath);
    },
  );

  // --- Token code navigation (P7) ---------------------------------------------
  // Cmd/Ctrl-click a token resolves symbol defs/refs (parity with DiffViewer and
  // the legacy all-files view). File identity comes from the owning item, not an
  // active-file side channel. Only wired when onCodeNavRequest is provided.
  const handleTokenClick = useStableCallback(
    (props: DiffTokenEventBaseProps, event: MouseEvent, item: CodeViewItem<DiffAnnotationMetadata>) => {
      if (!onCodeNavRequest || item.type !== 'diff') return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const filePath = itemIdToFilePath.get(item.id);
      if (filePath == null) return;
      onCodeNavRequest(buildCodeNavRequest(props, filePath));
    },
  );

  const handleTokenEnter = useStableCallback(
    (props: DiffTokenEventBaseProps, event: PointerEvent) => {
      if (onCodeNavRequest && (event.metaKey || event.ctrlKey)) {
        props.tokenElement.classList.add('pn-token-nav');
      }
    },
  );

  const handleTokenLeave = useStableCallback((props: DiffTokenEventBaseProps) => {
    props.tokenElement.classList.remove('pn-token-nav');
  });

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

  // --- Selected-annotation navigation (P4) -----------------------------------

  // Selecting an annotation in the sidebar must expand its owning file (if
  // collapsed) and scroll to it. We expand via item state (collapsed=false +
  // version bump + updateItem — the Diffshub pattern), then scrollTo the
  // annotation's line range so it lands in view. rAF defers the scroll one frame
  // so the expand's layout has settled before CodeView resolves the line top.
  useEffect(() => {
    if (!selectedAnnotationId) return;
    const ann = annotations.find((a) => a.id === selectedAnnotationId);
    if (!ann) return;
    const itemId = filePathToItemId.get(ann.filePath);
    if (itemId == null) return;
    const handle = viewerRef.current;
    if (handle == null) return;

    const item = handle.getItem(itemId);
    if (item != null && item.collapsed === true) {
      item.collapsed = false;
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
    }

    const start = Math.min(ann.lineStart, ann.lineEnd);
    const end = Math.max(ann.lineStart, ann.lineEnd);
    const side = ann.side === 'new' ? ('additions' as const) : ('deletions' as const);
    const raf = requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (viewer == null) return;
      viewer.scrollTo({ type: 'range', id: itemId, range: { start, end, side } });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedAnnotationId, annotations, filePathToItemId]);

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

  const renderCustomHeader = useStableCallback((item: CodeViewItem<DiffAnnotationMetadata>) => {
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
  // usePierreTheme forces `line-height: 1.5` ONLY when a custom font size is
  // set. In that case CodeView's pre-measure row-height estimate must match
  // (fontPx * 1.5) or virtualization/scroll estimates drift. With no custom
  // size, Pierre's default lineHeight estimate is correct — leave it unset.
  const customLineHeight = useMemo(() => {
    if (!fontSize) return undefined;
    const px = parseFloat(fontSize);
    return Number.isFinite(px) && px > 0 ? Math.round(px * 1.5) : undefined;
  }, [fontSize]);

  const options = useMemo<CodeViewOptions<DiffAnnotationMetadata>>(
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
        ...(customLineHeight != null && { lineHeight: customLineHeight }),
      },
      onLineSelectionEnd(range, context) {
        handleLineSelectionEnd(range, context.item);
      },
      onGutterUtilityClick(range, context) {
        handleGutterUtilityClick(range, context.item);
      },
      // P7: token code navigation. CodeView appends the owning-item context as
      // the final arg to every shared callback (same as the selection/gutter
      // callbacks), so file identity comes from context.item — no geometry or
      // active-file inference. Only wired when onCodeNavRequest is provided.
      ...(onCodeNavRequest && {
        onTokenClick(props, event, context) {
          handleTokenClick(props, event, context.item);
        },
        onTokenEnter(props, event, _context) {
          handleTokenEnter(props, event);
        },
        onTokenLeave(props, _event, _context) {
          handleTokenLeave(props);
        },
      }),
      // P5: lazily augment an item with full file content when it enters the
      // rendered window. P6: (re)apply / clear search marks per item so they
      // survive recycling. CodeView appends the item context as the final arg.
      onPostRender(node, _instance, phase, context) {
        handlePostRender(node, _instance, phase, context.item);
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
      customLineHeight,
      handleLineSelectionEnd,
      handleGutterUtilityClick,
      onCodeNavRequest,
      handleTokenClick,
      handleTokenEnter,
      handleTokenLeave,
      handlePostRender,
    ],
  );

  return (
    <div className={`relative h-full ${isDraggingSplit ? 'select-none' : ''}`}>
      <CodeView<DiffAnnotationMetadata>
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
        renderAnnotation={renderAnnotation}
      />

      {/* Center split dragger (P7) — one vertical line for the whole CodeView
          container, pinned at `splitRatio` of its width. Positioned relative to
          the container (not any virtualized item), so it is unaffected by
          virtualization, sticky headers, or paged-scroll rebasing. The vars it
          writes resize every split file's columns uniformly. */}
      {showSplitDragger && (
        <div
          className="absolute top-0 bottom-0 z-20 cursor-col-resize group"
          style={{ left: `${splitRatio * 100}%`, width: 9, marginLeft: -4 }}
          onPointerDown={handleSplitDragStart}
          onDoubleClick={resetSplitRatio}
          title="Drag to resize columns (double-click to reset)"
        >
          <div className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border transition-[width,background-color] group-hover:w-0.5 group-hover:bg-primary/50 group-active:w-0.5 group-active:bg-primary/70" />
        </div>
      )}

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
    </div>
  );
};
