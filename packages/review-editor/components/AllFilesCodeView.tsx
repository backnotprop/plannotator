import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { CodeView, EditProvider, type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
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
import { usePierreTheme } from '../hooks/usePierreTheme';
import { useIsWorkerPoolReadyOrDisabled, useWorkerPoolThemeSync } from '../workerPool';
import type { DiffFile, AnnotationScrollTarget } from '../types';
import { buildFileTree, getVisualFileOrder } from '../utils/buildFileTree';
import { buildCodeNavRequest } from '../utils/buildCodeNavRequest';
import { getDiffSelection, getLineNumberFromNode, getSideFromNode } from '../utils/diffSelection';
import { isContentConsistentWithPatch } from '../utils/patchConsistency';
import { hashString } from '../utils/hashString';
import {
  resolveLineSelectionBehavior,
  type LineSelectionSource,
} from '../utils/lineSelectionBehavior';
import { isContentlessBinaryPatch, isOversizedReviewStubPatch } from '@plannotator/shared/diff-paths';
import { OversizedFileNotice } from './OversizedFileNotice';
import { ToolbarHost, type ToolbarHostHandle } from './ToolbarHost';
import { FileHeader } from './FileHeader';
import { BinaryFileNotice } from './BinaryFileNotice';
import { GeneratedFileNotice } from './GeneratedFileNotice';
import { EditSessionHud } from './EditSessionHud';
import { FileCommentBanner } from './FileCommentBanner';
import { annotationMatchesPrScope, isFileScopedAnnotation, lineRangeForAnnotation } from '../utils/annotationScope';
import { useEditSession } from '../edit/useEditSession';
import type { EditSelectionAnnotationRequest, EditSelectionComment } from '../edit/useEditSession';
import type { SuggestionHunk } from '../edit/deriveSuggestions';
import { lineAnnotationMetadata } from '../utils/annotationDisplay';
import { InlineAnnotation } from './InlineAnnotation';
import { InlineAIMarker } from './InlineAIMarker';
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
 * scroll container. This IS the all-files surface — the legacy per-file
 * `FileDiff` list (`AllFilesDiffView` + `LazyFileDiff`) and its
 * `allFilesCodeView` config flag were deleted once the migration completed.
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
 *  - Fetches are guarded (one per item per diff generation) and cancellable
 *    (AbortController per item, all aborted on unmount / diff switch), so there
 *    is no fetch storm and no double-fetch.
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
 * P7 finished the edges that made CodeView the sole all-files renderer:
 *
 *  - No center split dragger: the legacy all-files view never had one, and a
 *    single global drag line across every file is noise on files where a
 *    split is meaningless (new/deleted files). Split columns use Pierre's
 *    default even 1fr/1fr layout; the single-file DiffViewer keeps its
 *    per-file dragger.
 *  - Token code navigation: Cmd/Ctrl-click a token routes through
 *    `onCodeNavRequest` (parity with the single-file DiffViewer and the legacy
 *    all-files view), with the `pn-token-nav` affordance (the hover-only
 *    `pn-token-hover` class is a single-file DiffViewer extra, here as in the
 *    legacy all-files view). File identity comes from the CodeView callback
 *    context's owning item, never an active-file side channel.
 *  - Safari scroll guardian: NOT carried forward. The old DiffViewer guardian
 *    targeted the OverlayScrollbars viewport wrapping many separate FileDiff
 *    shadow nodes and restored scrollTop on a ">200 -> 0" jump heuristic.
 *    CodeView owns its own scroll model and deliberately rebases its DOM
 *    scrollTop, so that heuristic would fight Pierre. CodeView therefore keeps
 *    its native bounded scroll viewport on every form factor. A page-scroll
 *    proxy was physically rejected on iPhone because the document could outrun
 *    Pierre's virtual window and expose a large blank tail.
 *
 * The worker pool remains a later phase.
 *
 * EXPERIMENTAL edit-to-suggestion (flag-gated, default OFF): the plain
 * all-files panel can opt into Pierre's experimental edit mode. One file at a
 * time enters an in-place editor (lazy-loaded chunk); on completion the net
 * change is diffed against the pre-session content and becomes ordinary
 * suggestion annotations. The item's pristine FileDiffMetadata is deep-cloned
 * before the session and restored (version bump + updateItem) when it ends,
 * because Pierre's editor mutates the metadata in place. See
 * ../edit/useEditSession.ts and ../edit/pierreEditAdapter.ts.
 */
export interface AllFilesCodeViewProps {
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
  scrollTargetAnnotation: AnnotationScrollTarget | null;
  pendingSelection: SelectedLineRange | null;
  reviewBase?: string;
  reviewSnapshotId?: string;
  /** Compact coarse-pointer shell. Adjusts custom-header chrome and Pierre's
   * matching virtualization metric without changing desktop geometry. */
  compactTouchLayout?: boolean;
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
  /** Chrome preference (#1277): false hides the header Viewed buttons; the `v`
   *  shortcut and viewed state are unaffected. */
  showViewedControls?: boolean;
  stagedFiles?: Set<string>;
  onStage?: (filePath: string) => void;
  canStageFiles?: boolean;
  /** Same preference for the header Git Add buttons (`a` shortcut still works). */
  showStageControls?: boolean;
  /** Per-file staging gate — false for committed files in since-base mode. The
   * All-files surface lists committed files too, so mode-level canStageFiles is
   * not enough; without this the `a` shortcut / header would `git add` a
   * committed file (a no-op that still flips local staged/viewed state). */
  canStagePath?: (filePath: string) => boolean;
  stagingFile?: string | null;
  stageError?: string | null;
  /** Repo-relative paths marked `linguist-generated` in `.gitattributes`
   * (#1317). Their diffs SEED collapsed (GitHub-style) and their headers show
   * a "generated" tag. Presentation-only: the diff data is fully present, so
   * annotations, search, and augmentation behave normally once expanded. */
  generatedFiles?: Set<string>;
  /** Generated files the user explicitly expanded — session-local state the
   * OWNER keeps (outside this component) so expansion survives remounts and
   * fileSetKey re-seeds. Read at item-seed time via ref so expanding never
   * rebuilds the identity or remounts CodeView. */
  expandedGeneratedFiles?: Set<string>;
  /** Report a generated file's collapse change so the owner can maintain
   * expandedGeneratedFiles. Fires only for paths in generatedFiles. */
  onGeneratedFileCollapsedChange?: (filePath: string, collapsed: boolean) => void;
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
  /** Tokenized request to reveal a file through CodeView's own item navigation.
   *  Guided Review uses this for outline chips and sidebar/AI jumps. The token
   *  lets repeated requests for the same path fire again. */
  fileScrollTarget?: { filePath: string; token: number } | null;
  // Which left panel drives the item order: 'tree' (folders-first visual
  // order) or 'list' (files array verbatim — the sections view's order).
  fileOrder?: 'tree' | 'list';
  // Collapse-all lives in the dock tab strip: register the toggle handler and
  // mirror the collapsed flag so the header button can drive/reflect it.
  registerCollapseAllToggle?: (toggle: (() => void) | null) => void;
  onAllCollapsedChange?: (collapsed: boolean) => void;
  /** Seed every file collapsed (commit diffs open as a folded overview under
   * the commit-description header). The collapse-all toggle still works. */
  defaultCollapsed?: boolean;
  /** Guide-only seed captured once for this component mount. Local collapse
   * changes therefore do not alter CodeView's key; a true outer remount captures
   * the shell's latest value. */
  mountCollapsed?: boolean;
  /** Restore an inner CodeView position after an outer virtualized shell remounts. */
  initialScrollPosition?: number;
  /** Persist the current inner CodeView position outside this component. */
  onScrollPositionChange?: (position: number) => void;
  /** Report collapse changes so an outer shell can preserve them across remounts. */
  onFileCollapsedChange?: (filePath: string, collapsed: boolean) => void;
  /** Content rendered ABOVE the first file, inside the scroller — it scrolls
   * away with the diff (not pinned). Implemented as layout.paddingTop +
   * a portal into CodeView's scroll container, since CodeView owns both the
   * scroller and the virtualized items. */
  leadingContent?: React.ReactNode;
  // Only handle [/]/z/v/a/c/x keyboard nav when this surface is the active panel.
  isActive?: boolean;
  // AI props (optional — surfaced into the toolbar). File-aware variants: this
  // surface owns which file the selection lives in (activeFilePath), so the
  // index-based onAskAI/aiHistoryForSelection (which resolve the file from the
  // single-file panel's focus) must not be used here.
  aiAvailable?: boolean;
  onAskAIForFile?: (filePath: string, question: string) => void;
  isAILoading?: boolean;
  onViewAIResponse?: (questionId?: string) => void;
  /** Line-scoped questions rendered as inline sparkle markers. */
  aiMessages?: AIChatEntry[];
  onClickAIMarker?: (questionId: string) => void;
  getAIHistoryForFile?: (filePath: string) => AIChatEntry[];
  /** Let wheel/touch gestures continue into a containing page when this nested
   * viewer reaches either vertical boundary. Guided Review file cards opt in. */
  allowScrollChaining?: boolean;
  /**
   * Portable / read-only host (the exported Guided Review viewer): no line or
   * gutter selection, no annotation toolbar or comment popovers, no global
   * keyboard shortcuts, no /api/file-content augmentation, no open-in
   * affordance. Everything the diff LOOKS like is unchanged — this only turns
   * off surfaces that require the review server or mutate review state.
   * See adr/decisions/007-portable-guided-reviews-20260815.md (D2, D4).
   */
  readOnly?: boolean;
  /** EXPERIMENTAL flag-gated edit-to-suggestion mode. Only the plain all-files
   * dock panel passes this — Guided Review surfaces deliberately do NOT (the
   * GuideViewportManager evicts CodeViews beyond ~8 mounted, which would
   * destroy an active editor's state; scoping edit mode to this surface is the
   * simple safe v1 choice). When absent/false, no edit UI renders and no
   * editor is ever constructed (code-split hosts also never fetch the editor
   * chunk; the single-file build inlines it, functionally inert). */
  enableEditSuggestions?: boolean;
  /** Sink for suggestions derived from a completed edit session. Required for
   * edit mode to activate. */
  onAddSuggestionsForFile?: (filePath: string, hunks: SuggestionHunk[]) => void;
  /** Sink for a comment authored through the edit session's Selection Action
   * ("Make annotation"): a line-scoped comment anchored to PRISTINE new-side
   * lines snapshotted at selection time (see edit/selectionAnchor.ts). */
  onAddEditorCommentForFile?: (filePath: string, comment: EditSelectionComment) => void;
}

// Diffshub-style stable path-based id allocation. Plannotator's file list is
// normally one entry per (new) path, so ids are identity (id === path) in the
// common case. Pathological patches (e.g. a delete + re-add of the same path,
// or repeated paths) would otherwise collapse two files onto one CodeView item,
// breaking selection/scroll identity — so a per-base suffix disambiguates them
// while still keeping filePath <-> itemId maps for constant-time lookups.
interface ItemIdentity {
  items: CodeViewItem<DiffAnnotationMetadata>[];
  /** Maps a file path to the CodeView item id that owns it. */
  filePathToItemId: Map<string, string>;
  /** Maps a file path to ALL item ids rendering it (duplicate display paths
   * produce twins; updates keyed by path must fan out to every twin). */
  filePathToItemIds: Map<string, string[]>;
  /** Maps a CodeView item id back to the originating file path. */
  itemIdToFilePath: Map<string, string>;
  /** Maps a CodeView item id to its originating DiffFile. Keyed by the unique
   * item id (not path) so duplicate display paths resolve to the correct file. */
  itemIdToFile: Map<string, DiffFile>;
}

// The first rendered line of a file's diff, used to anchor file-scoped comments.
// Pierre suppresses the header-prefix slot whenever a custom header is present
// (renderDiffChildren makes them mutually exclusive), so file comments can't
// live "between header and body" — instead they ride the line-annotation slot
// Project a file's LINE annotations into Pierre's DiffLineAnnotation shape (side,
// lineNumber = lineEnd, metadata = DiffAnnotationMetadata). File-scoped comments
// are deliberately excluded — they render in the file header (renderCustomHeader),
// not the gutter (see fileCommentsByPath).
export function projectFileAIMarkers(
  aiMessages: AIChatEntry[],
  filePath: string,
): DiffLineAnnotation<DiffAnnotationMetadata>[] {
  return aiMessages
    .filter(
      ({ question }) =>
        question.filePath === filePath &&
        question.lineStart != null &&
        question.lineEnd != null,
    )
    .map(({ question, response }) => ({
      side: question.side === 'new' ? ('additions' as const) : ('deletions' as const),
      lineNumber: question.lineEnd!,
      metadata: {
        annotationId: question.id,
        type: 'comment' as CodeAnnotationType,
        kind: 'ai-marker' as const,
        questionId: question.id,
        promptPreview: question.prompt.slice(0, 40) + (question.prompt.length > 40 ? '...' : ''),
        hasResponse: !!response.text && !response.error,
        isStreaming: response.isStreaming,
      },
    }));
}

function projectFileAnnotations(
  annotations: CodeAnnotation[],
  aiMessages: AIChatEntry[],
  filePath: string,
  prUrl: string | undefined,
  prDiffScope: string | undefined,
): DiffLineAnnotation<DiffAnnotationMetadata>[] {
  const reviewAnnotations = annotations
    .filter(
      (a) =>
        a.filePath === filePath &&
        (a.scope ?? 'line') === 'line' &&
        annotationMatchesPrScope(a, prUrl, prDiffScope),
    )
    .map((ann) => ({
      side: ann.side === 'new' ? ('additions' as const) : ('deletions' as const),
      lineNumber: ann.lineEnd,
      metadata: lineAnnotationMetadata(ann),
    }));
  return [...reviewAnnotations, ...projectFileAIMarkers(aiMessages, filePath)];
}

function buildItemIdentity(
  files: DiffFile[],
  visualOrder: number[],
  annotations: CodeAnnotation[],
  aiMessages: AIChatEntry[],
  prUrl: string | undefined,
  prDiffScope: string | undefined,
  patchHashes: string[],
  seedCollapsed: boolean,
  generatedFiles: Set<string> | undefined,
  expandedGeneratedFiles: Set<string> | undefined,
): ItemIdentity {
  const items: CodeViewItem<DiffAnnotationMetadata>[] = [];
  const filePathToItemId = new Map<string, string>();
  const filePathToItemIds = new Map<string, string[]>();
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
    // getSingularPatch throws when a patch doesn't parse to exactly one file.
    // The legacy per-file surface isolated such failures to one FileDiff; here
    // one bad patch must not take down the whole all-files surface — skip the
    // file (it remains reachable via the tree / single-file panel).
    let fileDiff: FileDiffMetadata;
    try {
      fileDiff = getSingularPatch(file.patch);
    } catch (err) {
      console.warn(`AllFilesCodeView: skipping unparseable patch for ${file.path}`, err);
      continue;
    }
    const id = allocateId(file.path);
    // cacheKey seeds worker highlighting (a later phase), whose cache is a
    // singleton that SURVIVES fileSetKey remounts — so the key must be unique
    // per item (duplicate display paths) AND per diff content (the same path
    // across a base/whitespace/PR switch carries different contents). The
    // content hash is the same one fileSetKey uses.
    fileDiff.cacheKey = `${id}#${patchHashes[index] ?? ''}`;
    // Seed annotations at build time so the first render (and any remount via
    // fileSetKey) already paints existing annotations without an extra update.
    const fileAnnotations = projectFileAnnotations(annotations, aiMessages, file.path, prUrl, prDiffScope);
    // Generated files (#1317) seed collapsed like GitHub's diff view, unless
    // the user already expanded them this session. A view-state seed only —
    // the item carries the full fileDiff either way.
    const seedFileCollapsed = seedCollapsed
      || (generatedFiles?.has(file.path) === true && expandedGeneratedFiles?.has(file.path) !== true);
    items.push({
      id,
      type: 'diff',
      fileDiff,
      version: 0,
      annotations: fileAnnotations,
      ...(seedFileCollapsed && { collapsed: true }),
    });
    // First occurrence of a path wins the canonical lookup so the file tree
    // (keyed by path) navigates to the primary item for that path.
    if (!filePathToItemId.has(file.path)) {
      filePathToItemId.set(file.path, id);
    }
    const twins = filePathToItemIds.get(file.path);
    if (twins) twins.push(id);
    else filePathToItemIds.set(file.path, [id]);
    itemIdToFilePath.set(id, file.path);
    itemIdToFile.set(id, file);
  }

  return { items, filePathToItemId, filePathToItemIds, itemIdToFilePath, itemIdToFile };
}

// Resolved pixel height of the custom header. Must equal FileHeader's fixed
// container height (`style={{ height: 'var(--panel-header-h)' }}`) so CodeView's
// virtualization reserves exactly the right space for the header. FileHeader is
// internally responsive (ResizeObserver shrinks labels) but its OUTER box height
// is fixed, so the responsive label changes never alter the row height.
const PANEL_HEADER_HEIGHT = 33; // --panel-header-h
const COMPACT_PANEL_HEADER_HEIGHT = 44;
// Hunk separator height forced by usePierreTheme unsafeCSS:
//   [data-separator='line-info'] { height: 24px; margin-block: 4px; }
// => 24 + 4*2 = 32. Pierre's own 'line-info' default metric is also 32, so
// passing it is redundant today — kept explicit so the metric stays pinned to
// OUR unsafeCSS rule rather than silently tracking a library default.
const HUNK_SEPARATOR_HEIGHT = 32;

// How long the scroller must be quiet before queued augmentation applies
// (item growth + re-render) are allowed to land. Slightly above Pierre's own
// post-interaction restore delay (120ms).
const AUGMENT_APPLY_IDLE_MS = 150;
const EMPTY_AI_MESSAGES: AIChatEntry[] = [];
const noopAIMarkerClick = () => {};

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
  scrollTargetAnnotation,
  pendingSelection,
  reviewBase,
  reviewSnapshotId,
  compactTouchLayout,
  onLineSelection,
  onAddAnnotationForFile,
  onEditAnnotation,
  onSelectAnnotation,
  onDeleteAnnotation,
  onAddFileCommentForFile,
  viewedFiles,
  onToggleViewed,
  showViewedControls = true,
  stagedFiles,
  onStage,
  canStageFiles = false,
  showStageControls = true,
  canStagePath,
  stagingFile,
  stageError,
  generatedFiles,
  expandedGeneratedFiles,
  onGeneratedFileCollapsedChange,
  prUrl,
  prDiffScope,
  searchQuery = '',
  searchMatches = [],
  activeSearchMatchId = null,
  activeSearchMatch = null,
  onCodeNavRequest,
  onVisibleFileChange,
  fileScrollTarget,
  fileOrder,
  registerCollapseAllToggle,
  onAllCollapsedChange,
  defaultCollapsed,
  mountCollapsed,
  initialScrollPosition = 0,
  onScrollPositionChange,
  onFileCollapsedChange,
  leadingContent,
  isActive = true,
  readOnly = false,
  aiAvailable = false,
  onAskAIForFile,
  isAILoading = false,
  onViewAIResponse,
  aiMessages = EMPTY_AI_MESSAGES,
  onClickAIMarker,
  getAIHistoryForFile,
  allowScrollChaining = false,
  enableEditSuggestions = false,
  onAddSuggestionsForFile,
  onAddEditorCommentForFile,
}) => {
  const mountCollapsedRef = useRef(mountCollapsed);
  const seedCollapsed = mountCollapsedRef.current ?? defaultCollapsed;

  // showFileHeader: true suppresses usePierreTheme's `[data-title]` hide rule.
  // With renderCustomHeader the built-in header runs in 'custom' mode (only the
  // header-custom slot, no [data-title] element), so that rule is moot either
  // way — we keep `true` to be explicit that the built-in title is irrelevant
  // here (our FileHeader owns all header chrome).
  const pierreTheme = usePierreTheme({
    fontFamily,
    fontSize,
    showFileHeader: true,
    compactTouchLayout,
  });
  // Worker-pool highlighting: wait for the pool so the first tokenization
  // wave runs in workers (not a main-thread fallback), and keep the pool's
  // theme pair in step with the UI theme.
  const workerPoolReady = useIsWorkerPoolReadyOrDisabled();
  useWorkerPoolThemeSync(pierreTheme.syntaxTheme);
  const viewerRef = useRef<CodeViewHandle<DiffAnnotationMetadata> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // State mirror of the scroll container so the leading-content portal can
  // mount once CodeView has rendered it (a plain ref can't trigger that).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const attachScrollContainer = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  // Measured height of the leading content (commit description card) — becomes
  // CodeView's layout.paddingTop so the virtualized items start below it and
  // the card scrolls away with the content like normal document flow.
  const [leadingHeight, setLeadingHeight] = useState(0);
  const leadingElRef = useRef<HTMLDivElement | null>(null);
  const attachLeadingEl = useCallback((el: HTMLDivElement | null) => {
    leadingElRef.current = el;
    if (el) setLeadingHeight(el.offsetHeight);
  }, []);
  useEffect(() => {
    const el = leadingElRef.current;
    if (!el) {
      setLeadingHeight(0);
      return;
    }
    const observer = new ResizeObserver(() => setLeadingHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollEl, leadingContent]);

  const toolbarHostRef = useRef<ToolbarHostHandle>(null);

  // NOTE: no center split dragger on this surface (parity with the legacy
  // all-files view, which never had one). One global drag line spanning every
  // file is noise on files where a split is meaningless (new/deleted files),
  // and the columns default to Pierre's even 1fr/1fr split. The single-file
  // DiffViewer keeps its per-file dragger.

  // The file path CodeView currently reports as visible (active-file highlight).
  // Reset on diff switch so stepping/highlighting never anchors on an old file.
  const visibleFileRef = useRef<string | null>(null);

  // The file CodeView last reported a selection / line-click in. The toolbar is
  // keyed off this file's path + patch, but the value is sourced from the
  // CodeView callback context (item.id) — never from geometry inference.
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  // Mirror ref so stable callbacks (Ask AI) read the active file at CALL time.
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  // A range whose toolbar must open only after the ToolbarHost remounts against
  // the newly-activated file (its patch/filePath props changed this render).
  const pendingToolbarRange = useRef<SelectedLineRange | null>(null);

  // File-scoped comment popover anchor (P3). Anchored by the FileHeader button
  // ref handed through the render slot — NOT by querying the recycled/portaled
  // header DOM (CodeView reuses header elements, so a DOM lookup is unreliable).
  const [fileCommentAnchor, setFileCommentAnchor] = useState<{ el: HTMLElement; filePath: string } | null>(null);
  // Per-file-comment-button ref map so the `c` keyboard shortcut can anchor the
  // popover without DOM querying. Eagerly populated/cleared by FileHeader's
  // fileCommentButtonRef callback as header slots mount/unmount (clicking also
  // refreshes the entry via handleFileComment).
  const fileCommentButtonRefs = useRef<Map<string, HTMLElement>>(new Map());

  // Previous snapshots of header-driving props (see the header-refresh effect
  // below). Declared up here with the other refs so the diff-switch reset effect
  // can resync them.
  const prevViewedRef = useRef<Set<string> | undefined>(viewedFiles);
  const prevStagedRef = useRef<Set<string> | undefined>(stagedFiles);
  const prevStagingRef = useRef<string | null | undefined>(stagingFile);
  const prevStageErrorRef = useRef<string | null | undefined>(stageError);
  // Previous line-card snapshots for the per-item annotation-sync effect (P4).
  const prevAnnotationsRef = useRef<CodeAnnotation[]>(annotations);
  const prevAIMessagesRef = useRef<AIChatEntry[]>(aiMessages);

  // Order items to mirror whichever left panel is active: 'tree' replays the
  // file-tree's visual order (folders-first); 'list' keeps the files array
  // order verbatim — which the sections view already arranged top-down
  // (committed → staged → unstaged → untracked). Scrolling this surface then
  // always tracks the visible left-panel list one-to-one.
  const visualOrder = useMemo(() => {
    if (fileOrder === 'list') return files.map((_, index) => index);
    const tree = buildFileTree(files);
    return getVisualFileOrder(tree);
  }, [files, fileOrder]);

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
  // seeded into items on (re)build via the latest refs for the first paint;
  // subsequent annotation/AI-message changes are applied incrementally per item
  // by the annotation-sync effect below (updateItem on only the changed file).
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const aiMessagesRef = useRef(aiMessages);
  aiMessagesRef.current = aiMessages;
  // Per-file patch content hashes — shared by fileSetKey (remount detection)
  // and the items' cacheKeys (highlight cache identity). Hashed once per
  // files-identity change.
  const patchHashes = useMemo(() => files.map((f) => hashString(f.patch)), [files]);
  // Generated-file collapse seeding (#1317). The generated SET is content-keyed
  // (generatedKey) so a refreshed payload carrying an equal set never rebuilds
  // the identity or remounts CodeView; the user's EXPANDED set is read via ref
  // so expanding a file (session state owned by App) never rebuilds either —
  // the live Pierre item already reflects it, and the ref makes any LATER
  // rebuild (diff switch, order change) re-seed those files expanded.
  const expandedGeneratedRef = useRef(expandedGeneratedFiles);
  expandedGeneratedRef.current = expandedGeneratedFiles;
  const generatedKey = useMemo(
    () => (generatedFiles && generatedFiles.size > 0 ? [...generatedFiles].sort().join('\n') : ''),
    [generatedFiles],
  );
  const identity = useMemo<ItemIdentity>(
    () => buildItemIdentity(
      files,
      visualOrder,
      annotationsRef.current,
      aiMessagesRef.current,
      prUrl,
      prDiffScope,
      patchHashes,
      seedCollapsed === true,
      generatedFiles,
      expandedGeneratedRef.current,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, visualOrder, prUrl, prDiffScope, patchHashes, seedCollapsed, generatedKey],
  );
  const { filePathToItemId, filePathToItemIds, itemIdToFilePath, itemIdToFile } = identity;

  // Stable identity of the current diff. Changes whenever the file set or any
  // file's patch CONTENT changes (diff type / base / whitespace / PR switch),
  // and is used as the CodeView `key` to force a remount + fresh seed.
  const fileSetKey = useMemo(
    // prUrl/prDiffScope are part of the key so a pure scope switch (layer ↔
    // full-stack, same file set) remounts and re-seeds annotations through the
    // current scope filter — the incremental sync bails on an unchanged
    // annotations ref and can't otherwise detect the filter change.
    // fileOrder is part of the key: CodeView seeds initialItems once per
    // instance, so an order change must remount to re-seed in the new order.
    // seedCollapsed is part of the key: normal surfaces can change their live
    // default, while guide mounts keep their captured seed stable.
    // generatedKey is part of the key (hashed — it can hold many paths): the
    // generated set only changes with a served payload, and a changed set must
    // remount so items re-seed through the new per-file collapse defaults.
    // The user's expandedGenerated set is deliberately NOT in the key —
    // expansion is live item state, and remounting on expand would lose
    // scroll/selection state.
    () => `${fileOrder ?? 'tree'}:${seedCollapsed ? 'c' : 'e'}:g${generatedKey ? hashString(generatedKey) : ''}:${prUrl ?? ''}:${prDiffScope ?? ''}:${reviewSnapshotId ?? ''}:${files.length}:${files.map((f, i) => `${f.path}#${patchHashes[i]}`).join('|')}`,
    [files, patchHashes, prUrl, prDiffScope, reviewSnapshotId, fileOrder, seedCollapsed, generatedKey],
  );

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
        // Paint the highlight on the TARGET item directly. The mirror effect
        // below can't be trusted to do this: it no-ops on value-equal ranges
        // (so a text-drag selecting the same line numbers as the previous
        // file's selection would leave the highlight stranded there), and it
        // pairs pendingSelection with activeFilePath, which hasn't committed
        // yet.
        const itemId = filePathToItemId.get(filePath);
        if (itemId != null) setSelectedLines({ id: itemId, range });
        // Publish the new range alongside the new active file so the
        // pendingSelection mirror effect never sees the PREVIOUS file's range
        // paired with the new activeFilePath (one-frame wrong highlight).
        // openToolbar re-publishes the same range when the deferred flush
        // runs — harmless duplicate.
        onLineSelection(range);
      }
    },
    [activeFilePath, onLineSelection, filePathToItemId],
  );

  // Once ToolbarHost has remounted against the newly-active file, flush the
  // deferred selection so the toolbar opens with the correct file + range.
  // Keyed on activeFilePath AND activePatch: two different files can carry
  // byte-identical patch text (two empty new files, the same one-line change),
  // in which case switching the active file does NOT change activePatch — and
  // a patch-only dependency would never flush, silently swallowing the
  // selection.
  useEffect(() => {
    if (pendingToolbarRange.current && activePatch) {
      toolbarHostRef.current?.handleLineSelectionEnd(pendingToolbarRange.current);
      pendingToolbarRange.current = null;
    }
  }, [activeFilePath, activePatch]);

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

  // Ask AI + AI history routed by THIS surface's active file (the file the
  // toolbar selection lives in) — never by the single-file panel's focus index.
  const handleAskAIForActiveFile = useMemo(() => {
    if (!onAskAIForFile) return undefined;
    return (question: string) => {
      const filePath = activeFilePathRef.current;
      if (filePath) onAskAIForFile(filePath, question);
    };
  }, [onAskAIForFile]);

  const aiHistoryForActiveFile = useMemo(
    () => (getAIHistoryForFile && activeFilePath ? getAIHistoryForFile(activeFilePath) : []),
    [getAIHistoryForFile, activeFilePath],
  );

  // Edit routes through the ToolbarHost handle (same as AllFilesDiffView). The
  // annotation's id resolves to the full CodeAnnotation so the toolbar opens
  // pre-filled. ToolbarHost is keyed to the active file's patch; startEdit
  // positions itself by last-known mouse position, so it works regardless of
  // which file the clicked annotation belongs to.
  // useStableCallback + ref read: this handler is baked into slot-portal
  // elements (InlineAnnotation onEdit) that only republish on version bumps,
  // so it must resolve the annotation at CALL time, never from a captured
  // closure.
  const handleEditAnnotation = useStableCallback((id: string) => {
    const ann = annotationsRef.current.find((a) => a.id === id);
    if (!ann) return;
    toolbarHostRef.current?.startEdit(ann);
  });

  // Per-file file-scoped comments, namespaced to the active PR/diff-scope. These
  // render in the file HEADER (renderCustomHeader, below the path) when the file
  // is expanded — not in the gutter — so they read as a file-level note rather
  // than a stray line comment.
  const fileCommentsByPath = useMemo(() => {
    const map = new Map<string, CodeAnnotation[]>();
    for (const a of annotations) {
      if (!isFileScopedAnnotation(a) || !annotationMatchesPrScope(a, prUrl, prDiffScope)) continue;
      const arr = map.get(a.filePath);
      if (arr) arr.push(a);
      else map.set(a.filePath, [a]);
    }
    return map;
  }, [annotations, prUrl, prDiffScope]);

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
      if (annotation.metadata.kind === 'ai-marker') {
        return (
          <InlineAIMarker
            questionId={annotation.metadata.questionId!}
            promptPreview={annotation.metadata.promptPreview!}
            hasResponse={annotation.metadata.hasResponse!}
            isStreaming={annotation.metadata.isStreaming!}
            onClick={onClickAIMarker ?? noopAIMarkerClick}
          />
        );
      }
      const filePath = itemIdToFilePath.get(item.id);
      return (
        <InlineAnnotation
          metadata={annotation.metadata}
          language={filePath ? detectLanguage(filePath) : undefined}
          isSelected={selectedAnnotationId === annotation.metadata.annotationId}
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
    // Keep the reader's place across a diff switch/refresh: if the file they
    // were on still exists in the new diff, scroll the remounted CodeView back
    // to it (rAF lets the seed render settle first). Matters most for the
    // staleness-refresh flow — "Refresh" must not dump the user at the top.
    const previousVisible = visibleFileRef.current;
    if (previousVisible) {
      const restoreId = filePathToItemId.get(previousVisible);
      if (restoreId != null) {
        requestAnimationFrame(() => {
          viewerRef.current?.scrollTo({ type: 'item', id: restoreId, align: 'start' });
        });
      }
    }
    setActiveFilePath(null);
    setSelectedLines(null);
    pendingToolbarRange.current = null;
    visibleFileRef.current = null;
    // An edit session cannot survive the CodeView remount (Pierre tears the
    // editor down without a completion callback), and fileSetKey also changes
    // on sort-order / collapse-default flips, not just diff switches. The
    // session controller drops a clean session silently; a dirty one prompts
    // to keep its recovered edits as suggestions (this effect runs
    // post-commit, so the synchronous confirm inside is safe).
    editSession.handleFileSetChange();
    // A pending editor-selection comment entry is anchored to the OLD diff's
    // pristine coordinates — stale once the file set changes.
    setSelectionAnnotationRequest(null);
    setFileCommentAnchor(null);
    fileCommentButtonRefs.current.clear();
    // Resync the header-refresh snapshots to the current props so the post-
    // remount header-refresh effect computes deltas against THIS diff, not the
    // previous one (the remounted items already seed from live props).
    prevViewedRef.current = viewedFiles;
    prevStagedRef.current = stagedFiles;
    prevStagingRef.current = stagingFile;
    prevStageErrorRef.current = stageError;
    // Line cards are seeded into the remounted items at build time, so resync
    // both snapshots here to avoid a spurious refresh post-remount.
    prevAnnotationsRef.current = annotations;
    prevAIMessagesRef.current = aiMessages;
    // Garbage-collect STALE-generation content fetches. Generation-aware on
    // purpose: this passive effect runs AFTER the remounted CodeView's seed
    // layout effect has already fired the new diff's first postRender wave —
    // augmentItem has started the NEW generation's fetches by the time we get
    // here, and a blanket abort+clear would kill our own generation's work
    // (re-fetch storm at best; an unaugmented initial window if the rAF
    // second wave loses the race). Stale generations are already inert — the
    // dedup guard ignores them and isStale() blocks their writes — so this
    // sweep is pure cleanup.
    for (const [itemId, entry] of augmentRef.current) {
      if (entry.generation === fileSetKey) continue;
      entry.controller.abort();
      augmentRef.current.delete(itemId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSetKey]);

  // --- Collapse via CodeView item state (Diffshub pattern + anchor fix) ------

  const [allCollapsed, setAllCollapsed] = useState(seedCollapsed === true);

  // Reset the global collapse toggle when the file set changes — items re-seed
  // with the current default on CodeView remount.
  useEffect(() => setAllCollapsed(seedCollapsed === true), [identity.items, seedCollapsed]);

  // Re-derive the collapse-all mirror from live item state after any
  // per-file toggle. Matters most for commit diffs (seeded all-collapsed):
  // without this, expanding one file left the dock button on "Expand all",
  // and clicking it re-collapsed the file the user just opened.
  const syncAllCollapsedMirror = useStableCallback(() => {
    const handle = viewerRef.current;
    if (handle == null) return;
    const anyExpanded = identity.items.some(
      ({ id }) => handle.getItem(id)?.collapsed !== true,
    );
    setAllCollapsed(!anyExpanded);
  });

  const reportFileCollapsed = useStableCallback((itemId: string, collapsed: boolean) => {
    const filePath = itemIdToFilePath.get(itemId);
    if (!filePath) return;
    onFileCollapsedChange?.(filePath, collapsed);
    // Generated files (#1317): let the owner track explicit expansion so it
    // survives remounts. Every collapse mutation funnels through here —
    // toggle, viewed+collapse, collapse/expand-all, the collapsed-placeholder
    // strip, and the navigation-driven expansions (guide outline, search
    // match, sidebar comment) — so the owner's set always mirrors the live
    // item state.
    if (generatedFiles?.has(filePath)) onGeneratedFileCollapsedChange?.(filePath, collapsed);
  });

  const toggleItemCollapsed = useStableCallback((itemId: string) => {
    const handle = viewerRef.current;
    const viewer = handle?.getInstance();
    const item = handle?.getItem(itemId);
    if (handle == null || viewer == null || item == null) return;

    // Collapsing a file that is mid-edit ends its session first (Pierre would
    // otherwise end it implicitly; routing through finishIfEditing keeps the
    // suggestion capture + pristine restore on our one code path).
    if (item.collapsed !== true) editSession.finishIfEditing(itemId);

    // If the item top is above scrollTop, re-anchor after the update so the
    // collapsing file stays in view (it would otherwise shift the content
    // below it upward, jumping the scroll). Diffshub anchor fix.
    const itemTop = viewer.getTopForItem(itemId);
    item.collapsed = item.collapsed !== true;
    item.version = (item.version ?? 0) + 1;
    if (!handle.updateItem(item)) return;
    syncAllCollapsedMirror();
    reportFileCollapsed(itemId, item.collapsed === true);

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
    editSession.finishIfEditing(itemId);
    item.collapsed = true;
    item.version = (item.version ?? 0) + 1;
    handle.updateItem(item);
    syncAllCollapsedMirror();
    reportFileCollapsed(itemId, true);
  });

  const isItemCollapsed = useCallback((itemId: string): boolean => {
    return viewerRef.current?.getItem(itemId)?.collapsed === true;
  }, []);

  // Collapse or expand every file at once — driven by the floating bottom-left
  // toggle. Pins scroll to the first file when collapsing so the view doesn't
  // jump into empty space.
  const setAllItemsCollapsed = useStableCallback((collapsed: boolean) => {
    const handle = viewerRef.current;
    if (handle == null) return;
    for (const { id } of identity.items) {
      const item = handle.getItem(id);
      if (item == null || (item.collapsed === true) === collapsed) continue;
      if (collapsed) editSession.finishIfEditing(id);
      item.collapsed = collapsed;
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
      reportFileCollapsed(id, collapsed);
    }
    if (collapsed) {
      const first = identity.items[0]?.id;
      if (first) handle.getInstance()?.scrollTo({ type: 'item', id: first, align: 'start' });
    }
  });

  const handleToggleAllCollapsed = useStableCallback(() => {
    const handle = viewerRef.current;
    if (handle == null) return;
    // If anything is open, collapse all; otherwise expand all. Computed from
    // live item state so it stays correct after manual per-file toggles.
    const anyExpanded = identity.items.some(
      ({ id }) => handle.getItem(id)?.collapsed !== true,
    );
    setAllItemsCollapsed(anyExpanded);
    setAllCollapsed(anyExpanded);
  });

  // The collapse-all control lives in the dock tab strip, not in this
  // component — register the handler (and mirror the collapsed flag) so the
  // header button can drive and reflect this view.
  useEffect(() => {
    registerCollapseAllToggle?.(handleToggleAllCollapsed);
    return () => registerCollapseAllToggle?.(null);
  }, [registerCollapseAllToggle, handleToggleAllCollapsed]);
  useEffect(() => {
    onAllCollapsedChange?.(allCollapsed);
  }, [onAllCollapsedChange, allCollapsed]);

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
  // `generation` is the fileSetKey at fetch start. It makes stale entries
  // self-invalidating across diff switches: the remounted CodeView's first
  // postRender wave fires BEFORE the diff-switch reset effect can clear this
  // map (layout vs passive effect timing), so an entry from the previous diff
  // must not satisfy the dedup guard — and a fetch from the previous diff must
  // never write into the new diff's (same-id) item.
  const augmentRef = useRef<
    Map<
      string,
      { status: 'pending' | 'done' | 'error'; controller: AbortController; generation: string }
    >
  >(new Map());
  // reviewBase / itemIdToFile / fileSetKey read through refs so the stable
  // onPostRender callback always sees the latest values without changing
  // identity (which would otherwise churn the CodeView options object).
  const reviewBaseRef = useRef(reviewBase);
  reviewBaseRef.current = reviewBase;
  const reviewSnapshotIdRef = useRef(reviewSnapshotId);
  reviewSnapshotIdRef.current = reviewSnapshotId;
  const itemIdToFileRef = useRef(itemIdToFile);
  itemIdToFileRef.current = itemIdToFile;
  const fileSetKeyRef = useRef(fileSetKey);
  fileSetKeyRef.current = fileSetKey;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // --- Edit-to-suggestion sessions (EXPERIMENTAL, flag-gated) -----------------
  // One file at a time; the editor chunk lazy-loads on first entry; the item's
  // pristine FileDiffMetadata is deep-cloned before the session and restored
  // (via version bump + updateItem) when it ends. See useEditSession.
  const editEnabled = enableEditSuggestions && onAddSuggestionsForFile != null;
  // A pending "Make annotation" request from the edit session's Selection
  // Action popover. The Pierre popover (shadow DOM) only snapshots the
  // selection; the actual comment entry is the app's own CommentPopover,
  // anchored at the snapshotted rect — focusing an input inside the editor's
  // popover would blur the editor, collapse the selection, and tear the
  // popover down mid-typing, so entry deliberately lives OUTSIDE the editor.
  const [selectionAnnotationRequest, setSelectionAnnotationRequest] =
    useState<EditSelectionAnnotationRequest | null>(null);
  const editSession = useEditSession({
    enabled: editEnabled,
    viewerRef,
    itemIdToFileRef,
    fileSetKeyRef,
    reviewBaseRef,
    reviewSnapshotIdRef,
    annotationsRef,
    onAddSuggestions: onAddSuggestionsForFile,
    onSelectionAnnotation: onAddEditorCommentForFile ? setSelectionAnnotationRequest : undefined,
    refreshItem,
  });

  // Surface a mid-session comment inside the editor as a marker as soon as it
  // lands in the annotations prop. Stable callback; no-op outside a session.
  const refreshEditSessionMarkers = editSession.refreshMarkers;
  useEffect(() => {
    refreshEditSessionMarkers();
  }, [annotations, refreshEditSessionMarkers]);

  // Augmentation APPLIES are deferred to scroll-idle. updateItem() mutates
  // item layout — the full-content parse counts collapsed-context regions the
  // raw-patch parse doesn't, so the item GROWS — and forces a re-render +
  // re-tokenize. Landing that mid-gesture causes visible chop; worse, when
  // the grown item sits ABOVE CodeView's scroll anchor, its corrective
  // scrollTo() kills wheel momentum and pins the viewport ("scrolling but
  // nothing changes"). Fetches still start as items enter the window — only
  // the item mutation waits for the scroll to settle. Staleness is re-checked
  // at apply time; the per-item map keeps only the newest apply per item.
  const pendingAugmentAppliesRef = useRef(new Map<string, () => void>());
  const augmentFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTsRef = useRef(0);

  const flushAugmentApplies = useCallback(() => {
    augmentFlushTimerRef.current = null;
    const idleFor = Date.now() - lastScrollTsRef.current;
    if (idleFor < AUGMENT_APPLY_IDLE_MS) {
      augmentFlushTimerRef.current = setTimeout(
        flushAugmentApplies,
        AUGMENT_APPLY_IDLE_MS - idleFor + 10,
      );
      return;
    }
    const applies = [...pendingAugmentAppliesRef.current.values()];
    pendingAugmentAppliesRef.current.clear();
    for (const apply of applies) apply();
  }, []);

  const queueAugmentApply = useCallback((itemId: string, apply: () => void) => {
    pendingAugmentAppliesRef.current.set(itemId, apply);
    if (augmentFlushTimerRef.current == null) {
      augmentFlushTimerRef.current = setTimeout(flushAugmentApplies, AUGMENT_APPLY_IDLE_MS);
    }
  }, [flushAugmentApplies]);

  useEffect(() => () => {
    if (augmentFlushTimerRef.current != null) clearTimeout(augmentFlushTimerRef.current);
  }, []);

  // Fetch full file contents for one item, reparse with processFile, and swap
  // the item's fileDiff in place so hunk expansion (expand-unchanged gutter
  // controls) works against the COMPLETE file. Mirrors LazyFileDiff's per-mount
  // fetch, but updates the existing CodeView item instead of mounting a fresh
  // FileDiff — so CodeView's own virtualization + element pool stay in charge.
  const augmentItem = useCallback((itemId: string) => {
    // NOTE: deliberately no viewerRef check here. The FIRST onPostRender wave
    // (every initially visible item) fires synchronously inside CodeView's seed
    // layout effect, which runs BEFORE useImperativeHandle assigns the handle —
    // so viewerRef.current is still null at that point. Bailing on a null
    // handle would make the initial window depend entirely on CodeView's
    // second (rAF `fitPerfectly`) render wave for augmentation — a library
    // implementation detail we'd rather not lean on. The handle is only needed
    // at fetch RESOLUTION, where it is re-read fresh from the ref.
    const augmentState = augmentRef.current;
    const generation = fileSetKeyRef.current;
    // One fetch per item PER DIFF: a same-generation entry ('pending' or
    // resolved) means do nothing — an item re-entering the rendered window
    // re-fires onPostRender, and this guard is what prevents the fetch storm.
    // An entry from a PREVIOUS diff (stale generation) does not count: abort it
    // and fetch fresh for the new diff's content.
    const existing = augmentState.get(itemId);
    if (existing) {
      if (existing.generation === generation) return;
      existing.controller.abort();
    }

    // Resolve the file by item id (NOT path) so duplicate display paths each
    // augment with their own DiffFile content.
    const file = itemIdToFileRef.current.get(itemId);
    if (file == null) return;

    const controller = new AbortController();

    // Read-only hosts have no review server: leave the raw-patch context in
    // place and mark the item done so it never re-fires (no dead requests,
    // no console noise from a CSP that blocks connect-src).
    if (readOnlyRef.current) {
      augmentState.set(itemId, { status: 'done', controller, generation });
      return;
    }
    augmentState.set(itemId, { status: 'pending', controller, generation });

    // A resolution stage is stale when its fetch was aborted (unmount / diff
    // switch) or the diff generation moved on while the response was in flight
    // (abort() is a no-op on an already-settled fetch, and the remounted
    // CodeView reuses path-derived item ids — without the generation check the
    // OLD diff's content would be written into the NEW diff's item). Stale
    // stages must not touch augmentState either: it now belongs to the new
    // generation.
    const isStale = () =>
      controller.signal.aborted || fileSetKeyRef.current !== generation;

    // Workspace-prefixed paths are passed through verbatim — /api/file-content
    // resolves the prefix back to the owning repo (same contract LazyFileDiff /
    // DiffViewer rely on).
    const params = new URLSearchParams({ path: file.path });
    if (file.oldPath) params.set('oldPath', file.oldPath);
    const base = reviewBaseRef.current;
    if (base) params.set('base', base);
    const snapshot = reviewSnapshotIdRef.current;
    if (snapshot) params.set('snapshot', snapshot);

    fetch(`/api/file-content?${params}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { oldContent: string | null; newContent: string | null } | null) => {
        if (isStale()) return;
        if (!data || (data.oldContent == null && data.newContent == null)) {
          // No content available (e.g. demo mode / binary): mark done so we do
          // not retry on every subsequent render. The raw-patch context still
          // shows; there is just nothing to expand.
          augmentState.set(itemId, { status: 'done', controller, generation });
          return;
        }

        // Stale-content guard: the file may have changed on disk since this
        // diff was captured (an agent editing/committing mid-review is normal
        // usage). Augmenting with contents that no longer reconcile with the
        // patch produces an internally inconsistent FileDiffMetadata — Pierre's
        // virtualization then fails layout estimation for the item ("trailing
        // context mismatch", content disappearing while scrolling). Keep the
        // raw-patch view for this file instead; a diff refresh re-augments.
        if (!isContentConsistentWithPatch(file.patch, data.oldContent, data.newContent)) {
          console.warn(
            `AllFilesCodeView: skipping full-content expansion for ${file.path} — file changed since the diff was captured`,
          );
          augmentState.set(itemId, { status: 'done', controller, generation });
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
          if (!result || result.isPartial) {
            augmentState.set(itemId, { status: 'done', controller, generation });
            return;
          }
          augmented = result;
        } catch {
          augmentState.set(itemId, { status: 'error', controller, generation });
          return;
        }

        if (isStale()) return;

        // Defer the item mutation to scroll-idle (see queueAugmentApply) —
        // landing it mid-gesture chops scrolling and can kill momentum via
        // CodeView's anchor-correcting scrollTo. All staleness checks re-run
        // at apply time: the queue can hold entries across aborts and diff
        // switches.
        queueAugmentApply(itemId, () => {
          if (isStale()) return;
          const liveHandle = viewerRef.current;
          const item = liveHandle?.getItem(itemId);
          // The item may have been torn down between fetch start and apply;
          // belt-and-suspenders on top of the staleness check above.
          if (liveHandle == null || item == null || item.type !== 'diff') {
            augmentState.set(itemId, { status: 'done', controller, generation });
            return;
          }
          // Never clobber an active edit session's document: the editor is
          // mutating item.fileDiff in place, and the session already ensured
          // full content before starting. Mark done — the pristine restore at
          // session end republishes whatever the session started from.
          if (itemId === editSession.editingItemIdRef.current) {
            augmentState.set(itemId, { status: 'done', controller, generation });
            return;
          }

          // cacheKey MUST change when fileDiff contents change (types.ts warning):
          // otherwise the worker / highlight caches would serve the stale partial
          // AST. Derive a fresh key from the augmented (now full-content) diff,
          // scoped by generation so the same item id across diff switches never
          // collides in a (future) cross-mount worker cache.
          augmented.cacheKey = `${generation}::${itemId}#full`;
          item.fileDiff = augmented;
          item.version = (item.version ?? 0) + 1;
          // updateItem re-measures the (now taller) item and resolves the captured
          // scroll anchor, so the viewport stays put whether this item is above or
          // below the fold — no manual scroll correction needed.
          liveHandle.updateItem(item);
          augmentState.set(itemId, { status: 'done', controller, generation });
        });
      })
      .catch((err) => {
        if (isStale()) {
          // Aborted (unmount / diff switch) or superseded: drop the entry only
          // if it is still ours — a newer generation may already own this id.
          if (augmentState.get(itemId)?.controller === controller) {
            augmentState.delete(itemId);
          }
          return;
        }
        augmentState.set(itemId, { status: 'error', controller, generation });
        void err;
      });
  }, [queueAugmentApply]);

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
  // Element -> owning item id, maintained by onPostRender below. CodeView
  // recycles <diffs-container> elements across items, so this is re-registered
  // on every mount/update and dropped on unmount.
  const nodeToItemIdRef = useRef(new WeakMap<HTMLElement, string>());

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
        nodeToItemIdRef.current.delete(node);
        return;
      }
      // Track which item currently owns this <diffs-container> element so the
      // text-drag selection handler can resolve file identity from the
      // selection's shadow-root host. Registered on every mount/update because
      // CodeView recycles elements across items.
      nodeToItemIdRef.current.set(node, context.id);
      augmentItem(context.id);
      const itemId = context.id;
      requestAnimationFrame(() => applyItemHighlights(node, itemId));
    },
  );

  // Parity with DiffViewer: dragging a text selection across multiple lines of
  // diff CONTENT (not the line-number gutter) opens the annotation toolbar for
  // that range. CodeView's enableLineSelection only starts drags from the
  // number column, so without this the all-files surface would silently lose
  // the select-code-text-to-annotate interaction the single-file panel has.
  // The owning file comes from the selection's shadow-root host element (each
  // item renders into its own <diffs-container>), mapped via nodeToItemIdRef.
  const handleContentTextSelection = useStableCallback(() => {
    requestAnimationFrame(() => {
      const root = scrollRef.current;
      const selection = getDiffSelection(root);
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
      const anchorLine = getLineNumberFromNode(selection.anchorNode);
      const focusLine = getLineNumberFromNode(selection.focusNode);
      if (anchorLine == null || focusLine == null) return;
      // Single-line drags keep native copy behavior (same rule as DiffViewer).
      if (anchorLine === focusLine) return;
      const rootNode = selection.anchorNode?.getRootNode();
      const host = rootNode instanceof ShadowRoot ? rootNode.host : null;
      const itemId = host instanceof HTMLElement ? nodeToItemIdRef.current.get(host) : undefined;
      if (itemId == null) return;
      // Text drags inside an active editor are the editor's own selection.
      if (itemId === editSession.editingItemIdRef.current) return;
      const filePath = itemIdToFilePath.get(itemId);
      if (filePath == null) return;
      routeSelectionToToolbar(
        {
          start: Math.min(anchorLine, focusLine),
          end: Math.max(anchorLine, focusLine),
          side: getSideFromNode(selection.anchorNode),
        },
        filePath,
      );
      selection.removeAllRanges();
    });
  });

  // (Re)attach on fileSetKey: the CodeView remount recreates the container
  // element scrollRef points at, dropping any previously-attached listener.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const handler = () => handleContentTextSelection();
    root.addEventListener('mouseup', handler, true);
    return () => root.removeEventListener('mouseup', handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSetKey]);

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
  // Gated on isActive (also a dep): scrolling while this panel is HIDDEN
  // resolves layout against a display:none container and there is no retry —
  // bail instead, and the isActive flip re-runs this effect so a match
  // selected while the panel was hidden scrolls once the panel is shown.
  useEffect(() => {
    if (!isActive) return;
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
      syncAllCollapsedMirror();
      reportFileCollapsed(itemId, false);
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
  }, [activeSearchMatch, filePathToItemId, isActive, syncAllCollapsedMirror, reportFileCollapsed]);

  // --- Annotations through CodeView item state (P4) ---------------------------

  // Set an item's review annotations and AI markers to the current per-file
  // projection, then republish that item only. This preserves CodeView scroll
  // state while streaming answers update their inline marker.
  const syncItemAnnotations = useCallback(
    (
      filePath: string,
      itemId: string,
      allAnnotations: CodeAnnotation[],
      allAIMessages: AIChatEntry[],
    ) => {
      const handle = viewerRef.current;
      const item = handle?.getItem(itemId);
      if (handle == null || item == null || item.type !== 'diff') return;
      item.annotations = projectFileAnnotations(
        allAnnotations,
        allAIMessages,
        filePath,
        prUrl,
        prDiffScope,
      );
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
    },
    [prUrl, prDiffScope],
  );

  // Keep review annotations incremental: a single add/edit/delete republishes
  // only files whose annotation signature changed. New diffs seed the current
  // projection during build, so this path never remounts CodeView.
  useEffect(() => {
    const handle = viewerRef.current;
    const prev = prevAnnotationsRef.current;
    prevAnnotationsRef.current = annotations;
    if (handle == null || prev === annotations) return;

    const signatures = (list: CodeAnnotation[]) => {
      const map = new Map<string, string>();
      for (const a of list) {
        const scope = a.scope ?? 'line';
        if (scope !== 'line' && scope !== 'file') continue;
        if (!annotationMatchesPrScope(a, prUrl, prDiffScope)) continue;
        // File comments carry different render-affecting fields than line notes
        // (no line/side/suggestion; they DO surface source + profile badges).
        const sig = scope === 'file'
          ? JSON.stringify([
              'F', a.id, a.text ?? '', a.source ?? '', a.author ?? '',
              a.reviewProfileLabel ?? '', a.conventionalLabel ?? '',
              (a.decorations ?? []).join(','), a.createdAt ?? 0, a.reasoning ?? '',
            ])
          : JSON.stringify([
              a.id, a.lineEnd, a.side, a.type,
              a.text ?? '', a.suggestedCode ?? '', a.originalCode ?? '',
              a.conventionalLabel ?? '', (a.decorations ?? []).join(','),
              a.severity ?? '', a.reasoning ?? '', a.author ?? '',
              a.reviewProfileLabel ?? '', a.source ?? '', a.createdAt ?? 0,
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
      for (const itemId of filePathToItemIds.get(path) ?? []) {
        syncItemAnnotations(path, itemId, annotations, aiMessages);
      }
    }
  }, [annotations, aiMessages, prUrl, prDiffScope, filePathToItemIds, syncItemAnnotations]);

  // AI answers stream independently of review annotations. Any message change
  // republishes only the files represented by the previous or next message set;
  // projectFileAnnotations performs the final line-scope/path filter.
  useEffect(() => {
    const handle = viewerRef.current;
    const prev = prevAIMessagesRef.current;
    // If the worker-pool gate still hides CodeView, retain the old snapshot.
    // The workerPoolReady dependency replays this sync once the handle exists.
    if (handle == null) return;
    prevAIMessagesRef.current = aiMessages;
    if (prev === aiMessages) return;

    const changedPaths = new Set<string>();
    for (const { question } of [...prev, ...aiMessages]) {
      if (question.filePath) changedPaths.add(question.filePath);
    }
    for (const path of changedPaths) {
      for (const itemId of filePathToItemIds.get(path) ?? []) {
        syncItemAnnotations(path, itemId, annotations, aiMessages);
      }
    }
  }, [aiMessages, annotations, filePathToItemIds, syncItemAnnotations, workerPoolReady]);

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
    // Generated tags (#1317) deliberately have no delta here: any
    // content-changed generated set remounts CodeView via fileSetKey
    // (generatedKey), so a delta on the live items is unreachable.
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
      // All twins of a duplicate path share viewed/staged state (it's keyed by
      // path), so refresh every item rendering it.
      for (const itemId of filePathToItemIds.get(path) ?? []) {
        refreshItem(itemId);
      }
    }
  }, [viewedFiles, stagedFiles, stagingFile, stageError, filePathToItemIds, refreshItem]);

  // The control-visibility preferences affect every header at once, so a
  // toggle refreshes all items (same slot-portal republish constraint as the
  // per-file sync above).
  const prevShowViewedRef = useRef(showViewedControls);
  const prevShowStageRef = useRef(showStageControls);
  useEffect(() => {
    const changed =
      prevShowViewedRef.current !== showViewedControls ||
      prevShowStageRef.current !== showStageControls;
    prevShowViewedRef.current = showViewedControls;
    prevShowStageRef.current = showStageControls;
    if (!changed || viewerRef.current == null) return;
    for (const itemIds of filePathToItemIds.values()) {
      for (const itemId of itemIds) refreshItem(itemId);
    }
  }, [showViewedControls, showStageControls, filePathToItemIds, refreshItem]);

  // --- Line selection through CodeView (replaces geometry-based inference) ---

  const handleSelectedLinesChange = useStableCallback(
    (selection: CodeViewLineSelection | null) => {
      setSelectedLines(selection);
      onLineSelection(selection ? selection.range : null);
    },
  );

  // Mirror ref so the pendingSelection effect below can compare against the
  // live CodeView selection without re-running on every drag delta.
  const selectedLinesRef = useRef(selectedLines);
  selectedLinesRef.current = selectedLines;

  // Reconcile the App-level `pendingSelection` (the range the toolbar / AI is
  // operating on) with CodeView's highlighted lines. CodeView selection is
  // CONTROLLED here, and `onSelectedLinesChange` fires on EVERY drag delta —
  // each delta already paints `selectedLines` on the owning item (correct id)
  // AND publishes the range to App. So when pendingSelection matches the live
  // selection, this effect must do NOTHING: re-deriving the highlight from
  // `activeFilePath` mid-drag would clear it (activeFilePath only updates at
  // pointer-up) or paint it on the previously-active file. It only acts on:
  //   1. pendingSelection cleared (annotation submitted / cancelled / AI done)
  //      → drop the highlight instead of leaving it stuck on the file.
  //   2. A toolbar-originated range CodeView doesn't know about (gutter-utility
  //      click on a not-yet-active file, draft restore) → paint it on the
  //      active file's item.
  // The controlled line highlight for a selected annotation (null for file-scoped
  // / unresolved). Shared by the compose-end restore and the selection-replay
  // effect so the two can't diverge.
  const lineSelectionForAnnotation = useStableCallback(
    (ann: CodeAnnotation | null | undefined): CodeViewLineSelection | null => {
      if (!ann || isFileScopedAnnotation(ann)) return null;
      const itemId = filePathToItemId.get(ann.filePath);
      return itemId != null ? { id: itemId, range: lineRangeForAnnotation(ann) } : null;
    },
  );
  // Mirror so the effect below can restore the selected comment's highlight when
  // a compose ends, without taking selectedAnnotationId as a dep.
  const selectedAnnotationIdRef = useRef(selectedAnnotationId);
  selectedAnnotationIdRef.current = selectedAnnotationId;
  useEffect(() => {
    if (pendingSelection == null) {
      // Compose ended — restore the selected line comment's highlight instead of
      // clearing, mirroring single-file's `pendingSelection ?? annotationRange`.
      const ann = selectedAnnotationIdRef.current
        ? annotationsRef.current.find((a) => a.id === selectedAnnotationIdRef.current)
        : null;
      setSelectedLines(lineSelectionForAnnotation(ann));
      return;
    }
    const current = selectedLinesRef.current;
    if (
      current != null &&
      current.range.start === pendingSelection.start &&
      current.range.end === pendingSelection.end &&
      current.range.side === pendingSelection.side
    ) {
      // Selection originated inside CodeView — already on the right item.
      return;
    }
    if (activeFilePath) {
      const itemId = filePathToItemId.get(activeFilePath);
      if (itemId != null) {
        setSelectedLines({ id: itemId, range: pendingSelection });
      }
    }
  }, [activeFilePath, pendingSelection, filePathToItemId]);

  const handleLineSelectionInteraction = useStableCallback(
    (
      source: LineSelectionSource,
      range: SelectedLineRange | null,
      item: CodeViewItem<DiffAnnotationMetadata>,
    ) => {
      if (range == null || item.type !== 'diff') return;
      // The file being edited owns its pointer interactions — opening the
      // annotation toolbar over an active editor would fight its focus.
      if (item.id === editSession.editingItemIdRef.current) return;
      const filePath = itemIdToFilePath.get(item.id);
      if (filePath == null) return;
      if (resolveLineSelectionBehavior({
        source,
        compactTouchLayout: compactTouchLayout === true,
      }) === 'preserve-selection') {
        pendingToolbarRange.current = null;
        setActiveFilePath(filePath);
        setSelectedLines({ id: item.id, range });
        onLineSelection(range);
        return;
      }
      routeSelectionToToolbar(range, filePath);
    },
  );

  const handleLineSelectionEnd = useStableCallback(
    (range: SelectedLineRange | null, item: CodeViewItem<DiffAnnotationMetadata>) => {
      handleLineSelectionInteraction('range-gesture', range, item);
    },
  );

  const handleGutterUtilityClick = useStableCallback(
    (range: SelectedLineRange, item: CodeViewItem<DiffAnnotationMetadata>) => {
      handleLineSelectionInteraction('gutter-comment-action', range, item);
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
    // At-bottom override (legacy parity): a short final file pinned at the
    // container bottom never gets its top above scrollTop+threshold, so the
    // loop would leave an earlier file active while the user reads the last
    // one. Uses CodeView's cached accessors — raw container.scrollHeight /
    // clientHeight reads here forced a synchronous layout on EVERY scroll
    // event, right after the frame's DOM writes (measurable jank).
    if (
      viewer.getScrollTop() + viewer.getHeight() >= viewer.getScrollHeight() - 2
    ) {
      bestId = rendered[rendered.length - 1].id;
    }
    const path = itemIdToFilePath.get(bestId) ?? null;
    if (path !== visibleFileRef.current) {
      visibleFileRef.current = path;
      onVisibleFileChange?.(path);
    }
  });

  // Coalesced to one run per animation frame — CodeView fires onScroll per
  // scroll EVENT, which can outpace frames during momentum scrolling. Also
  // stamps scroll activity for the augmentation idle-flush.
  const scrollReportRafRef = useRef<number | null>(null);
  const handleScroll = useStableCallback((position: number) => {
    lastScrollTsRef.current = Date.now();
    onScrollPositionChange?.(position);
    if (scrollReportRafRef.current != null) return;
    scrollReportRafRef.current = requestAnimationFrame(() => {
      scrollReportRafRef.current = null;
      reportVisibleFile();
    });
  });

  useEffect(() => () => {
    if (scrollReportRafRef.current != null) cancelAnimationFrame(scrollReportRafRef.current);
  }, []);

  // CodeView's onScroll only fires on actual scroll, so seed the initial
  // active-file highlight once the viewer has rendered its first window. rAF
  // gives CodeView a frame to mount + measure before we read rendered items.
  // Re-runs on `fileSetKey` because a diff switch remounts CodeView, so the
  // new diff's first file must be re-reported as the active file.
  useEffect(() => {
    const raf = requestAnimationFrame(() => reportVisibleFile());
    return () => cancelAnimationFrame(raf);
  }, [reportVisibleFile, fileSetKey]);

  // Outer Guide file shells survive while this CodeView is evicted. Restore
  // their last inner position once after this component mount; later parent
  // renders may expose a newer live ref value, but must not snap active scrolling.
  const hasRestoredInitialScrollRef = useRef(false);
  useEffect(() => {
    if (hasRestoredInitialScrollRef.current || initialScrollPosition <= 0) return;
    hasRestoredInitialScrollRef.current = true;
    const raf = requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({ type: 'position', position: initialScrollPosition });
    });
    return () => cancelAnimationFrame(raf);
  }, [fileSetKey, initialScrollPosition]);

  // --- [/]/z/v/a/c/x navigation + header actions driven by CodeView ----------

  const scrollToItem = useCallback((itemId: string) => {
    const viewer = viewerRef.current;
    if (viewer == null) return;
    viewer.scrollTo({ type: 'item', id: itemId, align: 'start' });
  }, []);

  // File-level navigation for surfaces whose lightweight navigation UI lives
  // outside CodeView (Guided Review's outline). Expand before scrolling so a
  // viewed/collapsed target reveals code rather than only its file header.
  // rAF waits for CodeView's initial seed/remount to publish the imperative
  // handle; token semantics allow the same file to be requested repeatedly.
  useEffect(() => {
    if (!fileScrollTarget) return;
    const itemId = filePathToItemId.get(fileScrollTarget.filePath);
    if (itemId == null) return;
    const raf = requestAnimationFrame(() => {
      const handle = viewerRef.current;
      const item = handle?.getItem(itemId);
      if (handle == null || item == null) return;
      if (item.collapsed === true) {
        item.collapsed = false;
        item.version = (item.version ?? 0) + 1;
        handle.updateItem(item);
        syncAllCollapsedMirror();
        reportFileCollapsed(itemId, false);
      }
      handle.scrollTo({ type: 'item', id: itemId, align: 'start' });
    });
    return () => cancelAnimationFrame(raf);
  }, [fileScrollTarget?.filePath, fileScrollTarget?.token, fileSetKey, filePathToItemId, syncAllCollapsedMirror, reportFileCollapsed]);

  // --- Selected-annotation highlight + navigation ----------------------------

  // SELECTION (inline card OR sidebar) paints the line highlight + repaints the
  // card ring — but NEVER scrolls. Clicking a comment in the diff must not move
  // the viewport. `annotations` is read through the ref so this fires only on
  // selection change, not on any add/edit/delete while one is selected.
  // Read-only mirror of pendingSelection so the selection effect can yield to an
  // active compose WITHOUT taking pendingSelection as a dep (which would re-run
  // it on every drag delta).
  const pendingSelectionRef = useRef(pendingSelection);
  pendingSelectionRef.current = pendingSelection;
  const prevSelectedFileRef = useRef<string | null>(null);
  useEffect(() => {
    const ann = selectedAnnotationId
      ? annotationsRef.current.find((a) => a.id === selectedAnnotationId)
      : null;
    const newFile = ann?.filePath ?? null;

    // Repaint the inline card's selected ring on the previously- AND
    // newly-selected file: renderAnnotation only re-runs on updateItem, so a bare
    // selection-state change wouldn't otherwise reach the portal'd cards.
    const filesToRefresh = new Set<string>();
    if (prevSelectedFileRef.current) filesToRefresh.add(prevSelectedFileRef.current);
    if (newFile) filesToRefresh.add(newFile);
    prevSelectedFileRef.current = newFile;
    for (const path of filesToRefresh) {
      for (const itemId of filePathToItemIds.get(path) ?? []) refreshItem(itemId);
    }

    // An active compose (toolbar open) owns selectedLines — clicking/deselecting a
    // comment must not clobber the in-progress range highlight. Mirrors
    // single-file DiffViewer's `pendingSelection ?? selectedAnnotationRange`.
    if (pendingSelectionRef.current != null) return;

    // Replay the selected line comment's range as the controlled highlight (the
    // same state a drag paints); file-scoped / deselection clears it.
    setSelectedLines(lineSelectionForAnnotation(ann));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAnnotationId, filePathToItemId, filePathToItemIds, refreshItem]);

  // NAVIGATION (sidebar only) — expand the owning file if collapsed and scroll
  // to the comment. Keyed on the navigation token so it fires per sidebar click
  // (re-clicking the same comment re-centers it) and NEVER on a bare in-diff
  // selection. rAF defers the scroll a frame so the expand's layout has settled.
  useEffect(() => {
    if (!scrollTargetAnnotation) return;
    const ann = annotationsRef.current.find((a) => a.id === scrollTargetAnnotation.id);
    if (!ann) return;
    const itemId = filePathToItemId.get(ann.filePath);
    const handle = viewerRef.current;
    if (itemId == null || handle == null) return;

    const item = handle.getItem(itemId);
    if (item != null && item.collapsed === true) {
      item.collapsed = false;
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
      syncAllCollapsedMirror();
      reportFileCollapsed(itemId, false);
    }

    const isFile = isFileScopedAnnotation(ann);
    const range = lineRangeForAnnotation(ann);
    const raf = requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (viewer == null) return;
      if (isFile) viewer.scrollTo({ type: 'item', id: itemId, align: 'start' });
      else viewer.scrollTo({ type: 'range', id: itemId, range });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTargetAnnotation, filePathToItemId]);

  useEffect(() => {
    if (!isActive || readOnly) return;
    const handler = (e: KeyboardEvent) => {
      // composedPath()[0] pierces shadow DOM: window-level e.target retargets
      // to the shadow HOST (e.g. <diffs-container>), which would hide a
      // typeable element living inside a shadow root from this guard.
      const el = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      )
        return;
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

      // z — re-expand + scroll to a collapsed file. Legacy used a collapse
      // history stack; we approximate with the nearest collapsed item AT or
      // BEFORE the current position in visual order (the file you most likely
      // just collapsed), falling back to the nearest one after it.
      if (e.key === 'z') {
        const collapsedIds = orderedItemIds.filter((id) => isItemCollapsed(id));
        if (collapsedIds.length === 0) return;
        e.preventDefault();
        const currentIdx = currentId ? orderedItemIds.indexOf(currentId) : -1;
        const target =
          [...collapsedIds]
            .reverse()
            .find((id) => orderedItemIds.indexOf(id) <= currentIdx) ?? collapsedIds[0];
        toggleItemCollapsed(target);
        scrollToItem(target);
        return;
      }

      // c — open the file-scoped comment popover for the current file. The
      // anchor element comes from the eager fileCommentButtonRef registration;
      // isConnected guards against an element whose header was recycled out of
      // the rendered window between registration and keypress.
      if (e.key === 'c' && currentPath && onAddFileCommentForFile) {
        e.preventDefault();
        const btn = fileCommentButtonRefs.current.get(currentPath);
        if (btn?.isConnected) setFileCommentAnchor({ el: btn, filePath: currentPath });
        return;
      }

      // v — toggle viewed (and collapse on mark-viewed) for the current file.
      if (e.key === 'v' && currentPath && currentId) {
        e.preventDefault();
        handleToggleViewedAndCollapse(currentPath, currentId);
        return;
      }

      // a — stage/unstage the current file (per-file gate: never a committed
      // file in since-base mode).
      if (e.key === 'a' && currentPath && (canStagePath ? canStagePath(currentPath) : canStageFiles)) {
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
    readOnly,
    orderedItemIds,
    filePathToItemId,
    itemIdToFilePath,
    scrollToItem,
    toggleItemCollapsed,
    isItemCollapsed,
    onAddFileCommentForFile,
    handleToggleViewedAndCollapse,
    canStageFiles,
    canStagePath,
    onStage,
  ]);

  // --- Custom header render slot (the full Plannotator FileHeader) -----------

  const renderCustomHeader = useStableCallback((item: CodeViewItem<DiffAnnotationMetadata>) => {
    if (item.type !== 'diff') return null;
    const filePath = itemIdToFilePath.get(item.id);
    if (filePath == null) return null;
    // Resolve by item id (NOT files.find by path): duplicate display paths each
    // have their own DiffFile, and a path lookup would render the FIRST file's
    // stats on every duplicate's header.
    const file = itemIdToFile.get(item.id);
    if (file == null) return null;

    const collapsed = item.collapsed === true;
    const fileComments = fileCommentsByPath.get(filePath) ?? [];
    // Edit-to-suggestion affordance (flag-gated). Slot portals republish on
    // updateItem BEFORE React commits state, so read the session's refs.
    const isEditingThis = editEnabled && editSession.editingItemIdRef.current === item.id;
    const editDisabledReason = editEnabled
      ? editSession.editUnavailableRef.current.get(filePath) ?? null
      : null;

    return (
      <div className="flex flex-col">
        <FileHeader
        compactTouchLayout={compactTouchLayout}
        readOnly={readOnly}
        filePath={filePath}
        patch={file.patch}
        status={file.status}
        oldPath={file.oldPath}
        onEditFile={editEnabled ? () => editSession.startEdit(item.id) : undefined}
        isEditing={isEditingThis}
        editDisabledReason={editDisabledReason}
        isViewed={viewedFiles?.has(filePath)}
        isGenerated={generatedFiles?.has(filePath) === true}
        onToggleViewed={onToggleViewed ? () => handleToggleViewedAndCollapse(filePath, item.id) : undefined}
        showViewedControl={showViewedControls}
        isStaged={stagedFiles?.has(filePath)}
        isStaging={stagingFile === filePath}
        onStage={onStage ? () => onStage(filePath) : undefined}
        canStage={canStagePath ? canStagePath(filePath) : canStageFiles}
        showStageControl={showStageControls}
        stageError={stagingFile === filePath ? stageError : null}
        onFileComment={onAddFileCommentForFile ? (anchorEl) => handleFileComment(filePath, anchorEl) : undefined}
        // Eager registration so the `c` shortcut can anchor the popover for a
        // file whose button was never clicked. Detach (null) deletes the entry
        // — React detaches the old ref before attaching the new one in the
        // same commit, so a slot republish never leaves the map stale.
        fileCommentButtonRef={
          onAddFileCommentForFile
            ? (el) => {
                if (el) fileCommentButtonRefs.current.set(filePath, el);
                else fileCommentButtonRefs.current.delete(filePath);
              }
            : undefined
        }
        collapseToggle={
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleItemCollapsed(item.id);
            }}
            data-pn-touch-target={compactTouchLayout || undefined}
            data-pn-touch-target-icon={compactTouchLayout || undefined}
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
        {/* A collapsed generated file must read as an intentional fold, never
            a failed render: an explicit placeholder strip with the counts,
            clickable through the SAME toggle funnel as the chevron. */}
        {collapsed && generatedFiles?.has(filePath) === true && (
          <GeneratedFileNotice
            additions={file.additions}
            deletions={file.deletions}
            onExpand={() => toggleItemCollapsed(item.id)}
            onHeightChange={() => refreshItem(item.id)}
          />
        )}
        {/* Files over the review size cap arrive as a contents-free stub, so
            Pierre renders nothing below the header. Explain why rather than
            leaving a bare header that reads as a broken diff. */}
        {!collapsed && isOversizedReviewStubPatch(file.patch) && (
          <OversizedFileNotice onHeightChange={() => refreshItem(item.id)} />
        )}
        {/* The general fallback under that specific case: any OTHER hunkless
            binary chunk draws nothing either. Gated on the marker so a
            marker-carrying stub is explained exactly once, by the line above. */}
        {!collapsed
          && !isOversizedReviewStubPatch(file.patch)
          && isContentlessBinaryPatch(file.patch) && (
          <BinaryFileNotice onHeightChange={() => refreshItem(item.id)} />
        )}
        {/* EXPERIMENTAL edit-session HUD: session controls + state in a slim
            strip below the header, above the file content. Appears/disappears
            with session start/end, which both go through a version-bumped
            updateItem, so the slot height is re-measured on each transition. */}
        {isEditingThis && (
          <EditSessionHud
            onComplete={editSession.completeEdit}
            onCancel={editSession.cancelEdit}
            dirtyStore={editSession.dirtyStore}
          />
        )}
        {/* File-scoped comments live in the header (below the path), shown only
            when the file is expanded. They ride the sticky header — fine for a
            short guide note; long ones scroll within the banner. */}
        {!collapsed && fileComments.length > 0 && (
          <FileCommentBanner
            comments={fileComments}
            selectedAnnotationId={selectedAnnotationId}
            onSelect={onSelectAnnotation}
            onEdit={onEditAnnotation}
            onDelete={onDeleteAnnotation}
            // Re-measure the item when a comment expands/collapses/edits — the
            // custom-header height isn't auto-observed, so without this the
            // content below would overlap until an unrelated refresh.
            onHeightChange={() => refreshItem(item.id)}
          />
        )}
      </div>
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
      enableLineSelection: !readOnly,
      enableGutterUtility: !readOnly,
      hunkSeparators: 'line-info',
      stickyHeaders: true,
      // Flush files together (no inter-file gap) — file boundaries already read
      // via the sticky header. Keep Pierre's default 8px list edge padding.
      // leadingHeight reserves space for the leading-content portal (commit
      // description card) so items start below it and it scrolls with them.
      layout: { gap: 0, paddingTop: 8 + leadingHeight, paddingBottom: 8 },
      itemMetrics: {
        diffHeaderHeight: compactTouchLayout ? COMPACT_PANEL_HEADER_HEIGHT : PANEL_HEADER_HEIGHT,
        hunkSeparatorHeight: HUNK_SEPARATOR_HEIGHT,
        ...(customLineHeight != null && { lineHeight: customLineHeight }),
      },
      // Opt-in safety net for the hand-maintained itemMetrics above: Pierre
      // compares its virtualization estimates against measured DOM heights and
      // warns on drift. Explicit env opt-in (VITE_PIERRE_VALIDATE_HEIGHTS=1)
      // rather than blanket DEV: validation runs getBoundingClientRect() per
      // rendered item per frame inside the scroll loop — it made the dev
      // server's scrolling visibly choppy on its own. Still doubly gated: the
      // option only takes effect when the library itself runs a development
      // build (NODE_ENV), so it is inert in production even if it leaks.
      ...(import.meta.env.DEV &&
        import.meta.env.VITE_PIERRE_VALIDATE_HEIGHTS === '1' && {
          __devOnlyValidateItemHeights: true,
        }),
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
        // Pierre's renderer-options builder drops onToken* before it evaluates
        // shouldUseTokenTransformer, so the handlers alone never wrap tokens
        // (no data-char) and token events never fire. Enable it explicitly.
        useTokenTransformer: true,
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
      readOnly,
      customLineHeight,
      compactTouchLayout,
      leadingHeight,
      handleLineSelectionEnd,
      handleGutterUtilityClick,
      onCodeNavRequest,
      handleTokenClick,
      handleTokenEnter,
      handleTokenLeave,
      handlePostRender,
    ],
  );

  // After all hooks: hold the surface until the worker pool can take the
  // first tokenization wave (≈100-300ms once per session; instant after).
  if (!workerPoolReady) {
    return <div className="relative h-full" />;
  }

  const codeView = (
    <CodeView<DiffAnnotationMetadata>
      // Remount on diff switch so uncontrolled `initialItems` re-seeds from
      // the freshly computed identity. Without this, switching diff
      // type/base/whitespace/PR with the all-files panel open would keep the
      // OLD diff on screen (the panel instance is reused, not recreated).
      key={fileSetKey}
      ref={viewerRef}
      containerRef={attachScrollContainer}
      // Containment mirrors Pierre's own production wrapper (diffshub
      // CodeViewWrapper): without it, every forced layout during scrolling
      // recomputes the whole document instead of the clipped subtree.
      // overflow-anchor:none disables the BROWSER's scroll anchoring, which
      // otherwise fights CodeView's own anchor resolution whenever item
      // heights change (our augmentation applies).
      className={`relative h-full overflow-y-auto overflow-x-clip ${allowScrollChaining ? 'overscroll-auto' : 'overscroll-contain'} [contain:strict] [overflow-anchor:none] [will-change:scroll-position] [&_diffs-container]:overflow-clip [&_diffs-container]:[contain:layout_paint_style]`}
      initialItems={identity.items}
      options={options}
      selectedLines={selectedLines}
      onSelectedLinesChange={handleSelectedLinesChange}
      onScroll={handleScroll}
      renderCustomHeader={renderCustomHeader}
      renderAnnotation={renderAnnotation}
      // Edit-to-suggestion (flag-gated): only wired when enabled so the
      // flag-off surface is byte-identical to the pre-feature one.
      {...(editEnabled && {
        editorOptions: editSession.editorOptions,
        onItemEditChange: editSession.onItemEditChange,
        onItemEditComplete: editSession.onItemEditComplete,
      })}
    />
  );

  return (
    <div className="relative h-full">
      {/* EditProvider only mounts when the experimental flag is on; its
          factory declines attaches until the lazy editor chunk has loaded
          (the chunk loads on first Edit click, never before). */}
      {editEnabled ? (
        <EditProvider createEditor={editSession.createEditor}>{codeView}</EditProvider>
      ) : (
        codeView
      )}

      {/* Leading content (commit description card) lives INSIDE the scroll
          container at content-top: absolutely positioned children of a scroller
          are part of its scrollable overflow, so the card scrolls away with
          the diff. layout.paddingTop (measured height) keeps items below it. */}
      {leadingContent && scrollEl &&
        createPortal(
          <div ref={attachLeadingEl} className="absolute top-0 left-0 right-0">
            {leadingContent}
          </div>,
          scrollEl,
        )}

      {!readOnly && (
      <ToolbarHost
        ref={toolbarHostRef}
        patch={activePatch}
        filePath={activeFilePath ?? ''}
        isFocused={true}
        onLineSelection={onLineSelection}
        onAddAnnotation={handleAddAnnotation}
        onEditAnnotation={onEditAnnotation}
        aiAvailable={aiAvailable}
        onAskAI={handleAskAIForActiveFile}
        isAILoading={isAILoading}
        onViewAIResponse={onViewAIResponse}
        aiHistoryMessages={aiHistoryForActiveFile}
      />
      )}

      {!readOnly && fileCommentAnchor && onAddFileCommentForFile && (
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

      {/* Comment entry for the edit session's "Make annotation" action. The
          anchor rect and the pristine line range were snapshotted at click
          time, so this stays valid even if the editor selection has since
          collapsed or the session has ended (pristine coordinates are
          session-invariant). */}
      {!readOnly && selectionAnnotationRequest && onAddEditorCommentForFile && (
        <CommentPopover
          key={`edit-selection:${selectionAnnotationRequest.filePath}:${selectionAnnotationRequest.lineStart}-${selectionAnnotationRequest.lineEnd}`}
          anchorRect={selectionAnnotationRequest.anchorRect}
          contextText={selectionAnnotationRequest.selectedText.replace(/\s+/g, ' ').trim()}
          isGlobal={false}
          allowImages={false}
          onSubmit={(text) => {
            onAddEditorCommentForFile(selectionAnnotationRequest.filePath, {
              lineStart: selectionAnnotationRequest.lineStart,
              lineEnd: selectionAnnotationRequest.lineEnd,
              exact: selectionAnnotationRequest.exact,
              selectedText: selectionAnnotationRequest.selectedText,
              text,
            });
            // The editor kept its ranged selection while the entry was open;
            // collapse it so the Selection Action popover does not re-open
            // over the just-annotated lines.
            editSession.collapseSelection();
            setSelectionAnnotationRequest(null);
          }}
          onClose={() => setSelectionAnnotationRequest(null)}
        />
      )}
    </div>
  );
};
