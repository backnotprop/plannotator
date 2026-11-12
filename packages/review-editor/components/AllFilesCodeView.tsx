import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextNoteAnchor } from '../utils/contextNoteAnchor';
import { createPortal } from 'react-dom';
import { DEFAULT_CODE_VIEW_FILE_METRICS, getSingularPatch, processFile } from '@pierre/diffs';
import type {
  CodeViewItem,
  CodeViewLineSelection,
  CodeViewOptions,
  DiffLineAnnotation,
  FileDiffLoadedFiles,
  FileDiffMetadata,
  PostRenderPhase,
  SelectedLineRange,
  VirtualFileMetrics,
} from '@pierre/diffs';
import { CodeView, EditProvider, type CodeViewAnnotationArgs, type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
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
import type { MarkdownFileView } from '../utils/markdownPreview';
import { buildFileTree, getVisualFileOrder } from '../utils/buildFileTree';
import { scrollWithPage, type PageScroll } from '../utils/scrollWithPage';
import { newLineOf } from '../utils/newLineOf';
import { fileKind } from '@plannotator/core/file-kind';
import { packageFileKind } from '@plannotator/core/package-changes';
import { getFileKindOrder } from '../utils/fileKindTree';
import { buildCodeNavRequest } from '../utils/buildCodeNavRequest';
import { getDiffSelection, getLineNumberFromNode, getSideFromNode, snapshotDiffSelection, rangeForGutterClick, type DiffSelectionSnapshot } from '../utils/diffSelection';
import { isContentConsistentWithPatch } from '../utils/patchConsistency';
import { isLineRangeInPatch } from '../utils/patchParser';
import { hashString } from '../utils/hashString';
import {
  resolveLineSelectionBehavior,
  type LineSelectionSource,
} from '../utils/lineSelectionBehavior';
import {
  changeJumpDirection,
  findChangeElement,
  listDiffChanges,
  placementOf,
  readingLineFor,
  renderedUnifiedRange,
  resolveChangeJump,
  type ChangePlacement,
  type DiffChange,
} from '../utils/changeNavigation';
import { isContentlessBinaryPatch, isImagePreviewCandidate, isOversizedReviewStubPatch } from '@plannotator/shared/diff-paths';
import { OversizedFileNotice } from './OversizedFileNotice';
import { ToolbarHost, type ToolbarHostHandle } from './ToolbarHost';
import type { DiffSelectionActions } from './SelectionChooser';
import { FileHeader } from './FileHeader';
import { DiffBottomBar } from './DiffBottomBar';
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
import {
  hostFileNoteSignatures,
  hostLineNoteSignatures,
  NO_HOST_FILE_NOTES,
  NO_HOST_LINE_NOTES,
  projectHostLineNotes,
  type HostFileNote,
  type HostLineNote,
} from './hostLineNotes';
import { detectLanguage } from '../utils/detectLanguage';
import type { AIChatEntry } from '../hooks/useAIChat';
import type { ReviewSearchMatch } from '../utils/reviewSearch';
import {
  applyItemSearchHighlights,
  clearItemSearchHighlights,
  swapActiveSearchHighlight,
} from '../utils/reviewSearchHighlight';

export type AllFilesOrder = 'tree' | 'kind' | 'list';

/**
 * AllFilesCodeView (migration phases P1 + P2 + P3 + P4) Renders every changed file through ONE
 * Pierre `CodeView` inside a single scroll container.
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
  hunkSeparators?: 'line-info' | 'simple';
  fontFamily?: string;
  fontSize?: string;
  annotations: CodeAnnotation[];
  hostLineNotes?: readonly HostLineNote[];
  hostFileNotes?: readonly HostFileNote[];
  selectedAnnotationId: string | null;
  scrollTargetAnnotation: AnnotationScrollTarget | null;
  pendingSelection: SelectedLineRange | null;
  reviewBase?: string;
  reviewSnapshotId?: string;
  contextExpansionAvailable?: boolean;
  fetchFileContent?: (file: DiffFile, signal: AbortSignal) => Promise<{ oldContent: string | null; newContent: string | null } | null>;
  renderImagePreview?: (args: {
    file: DiffFile;
    fallback: React.ReactNode;
    tooLargeFallback?: React.ReactNode;
    onHeightChange: () => void;
  }) => React.ReactNode;
  renderPackageChanges?: (args: { file: DiffFile; onHeightChange: () => void }) => React.ReactNode;
  markdownPreview?: {
    previewedPaths: ReadonlySet<string>;
    isPreviewable: (file: DiffFile) => boolean;
    show: (filePath: string, view: MarkdownFileView) => void;
    renderViewControl: (args: { file: DiffFile; iconOnly: boolean; touch: boolean }) => React.ReactNode;
    /** The file the edit session holds (null when none): its view must not change mid-edit. */
    onEditingFileChange?: (filePath: string | null) => void;
    /**
     * Registers how to find the Markdown file a view key should act on: the file holding focus or
     * under the pointer, else the top-most Markdown file in view (never the last file just because
     * the list fits).
     */
    registerViewTarget?: (resolve: (() => string | null) | null) => void;
    render: (args: { file: DiffFile; onHeightChange: () => void }) => React.ReactNode;
  };
  /** Compact coarse-pointer shell. Adjusts custom-header chrome and Pierre's
   * matching virtualization metric without changing desktop geometry. */
  compactTouchLayout?: boolean;
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
  onExplainAnnotation?: (id: string) => void;
  agentFindingSources?: ReadonlySet<string>;
  onAddFileCommentForFile?: (filePath: string, text: string) => void;
  viewedFiles?: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  showViewedControls?: boolean;
  stagedFiles?: Set<string>;
  onStage?: (filePath: string) => void;
  canStageFiles?: boolean;
  showStageControls?: boolean;
  canStagePath?: (filePath: string) => boolean;
  stagingFile?: string | null;
  stageError?: string | null;
  generatedFiles?: Set<string>;
  expandedGeneratedFiles?: Set<string>;
  onGeneratedFileCollapsedChange?: (filePath: string, collapsed: boolean) => void;
  prUrl?: string;
  prDiffScope?: string;
  searchQuery?: string;
  searchMatches?: ReviewSearchMatch[];
  activeSearchMatchId?: string | null;
  activeSearchMatch?: ReviewSearchMatch | null;
  onCodeNavRequest?: (request: import('@plannotator/shared/code-nav').CodeNavRequest) => void;
  onTokenHoverEnter?: (props: DiffTokenEventBaseProps, filePath: string) => void;
  onTokenHoverLeave?: () => void;
  onTokenTarget?: (kind: 'enter' | 'leave' | 'click', props: DiffTokenEventBaseProps, filePath: string) => void;
  onVisibleFileChange?: (filePath: string | null, info?: { collapsed: boolean }) => void;
  /**
   * Fired on a downward active-file transition once the passed file's successor has reached the
   * viewport top (so the file genuinely scrolled out above rather than merely losing the active
   * race), and on every at-bottom tick for the final file, which can never scroll out above.
   */
  onFileScrolledPast?: (filePath: string) => void;
  fileScrollTarget?: { filePath: string; token: number } | null;
  fileOrder?: AllFilesOrder;
  registerCollapseAllToggle?: (toggle: (() => void) | null) => void;
  onAllCollapsedChange?: (collapsed: boolean) => void;
  defaultCollapsed?: boolean;
  mountCollapsed?: boolean;
  initialScrollPosition?: number;
  onScrollPositionChange?: (position: number) => void;
  onFileCollapsedChange?: (filePath: string, collapsed: boolean) => void;
  leadingContent?: React.ReactNode;
  isActive?: boolean;
  aiAvailable?: boolean;
  onAskAIForFile?: (filePath: string, question: string) => void;
  isAILoading?: boolean;
  onViewAIResponse?: (questionId?: string) => void;
  aiMessages?: AIChatEntry[];
  contextNotes?: readonly ContextNoteAnchor[];
  renderContextNote?: (id: string) => React.ReactNode;
  onClickAIMarker?: (questionId: string) => void;
  getAIHistoryForFile?: (filePath: string) => AIChatEntry[];
  allowScrollChaining?: boolean;
  onContentHeightChange?: (height: number) => void;
  scrollsWithPage?: boolean;
  flushFiles?: boolean;
  headerKeepsFolder?: boolean;
  readOnly?: boolean;
  commentOnly?: boolean;
  fileOpenIn?: (filePath: string) => React.ReactNode;
  askOnly?: boolean;
  selectionActions?: DiffSelectionActions;
  enableEditSuggestions?: boolean;
  onAddSuggestionsForFile?: (filePath: string, hunks: SuggestionHunk[]) => void;
  onAddEditorCommentForFile?: (filePath: string, comment: EditSelectionComment) => void;
}

export type { ContextNoteAnchor } from '../utils/contextNoteAnchor';

/** A file's context notes as line annotations of their own kind (never `CodeAnnotation`s: no comment chrome, no count). */
export function projectFileContextNotes(
  notes: readonly ContextNoteAnchor[],
  filePath: string,
): DiffLineAnnotation<DiffAnnotationMetadata>[] {
  return notes
    .filter((note) => note.filePath === filePath)
    .map((note) => ({
      side: note.side === 'new' ? ('additions' as const) : ('deletions' as const),
      lineNumber: note.lineEnd,
      metadata: {
        annotationId: `context-note:${note.id}`,
        type: 'comment' as CodeAnnotationType,
        kind: 'context-note' as const,
        contextNoteId: note.id,
      },
    }));
}

// Pathological patches (e.g. a delete + re-add of the same path, or repeated paths) would otherwise
// collapse two files onto one CodeView item, breaking selection/scroll identity — so a per-base
// suffix disambiguates them while still keeping filePath <-> itemId maps for constant-time lookups.
interface ItemIdentity {
  items: CodeViewItem<DiffAnnotationMetadata>[];
  filePathToItemId: Map<string, string>;
  /** Maps a file path to ALL item ids rendering it (duplicate display paths
   * produce twins; updates keyed by path must fan out to every twin). */
  filePathToItemIds: Map<string, string[]>;
  itemIdToFilePath: Map<string, string>;
  itemIdToFile: Map<string, DiffFile>;
}

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

export function projectFileAnnotations(
  annotations: CodeAnnotation[],
  aiMessages: AIChatEntry[],
  filePath: string,
  prUrl: string | undefined,
  prDiffScope: string | undefined,
  contextNotes: readonly ContextNoteAnchor[] = EMPTY_CONTEXT_NOTES,
  hostLineNotes: readonly HostLineNote[] = NO_HOST_LINE_NOTES,
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
  const markers = projectFileAIMarkers(aiMessages, filePath);
  const hostNotes = projectHostLineNotes(hostLineNotes, filePath);
  if (contextNotes.length === 0) return [...hostNotes, ...reviewAnnotations, ...markers];
  return [...hostNotes, ...projectFileContextNotes(contextNotes, filePath), ...reviewAnnotations, ...markers];
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
  contextNotes: readonly ContextNoteAnchor[] = EMPTY_CONTEXT_NOTES,
  hostLineNotes: readonly HostLineNote[] = NO_HOST_LINE_NOTES,
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
    let fileDiff: FileDiffMetadata;
    try {
      fileDiff = getSingularPatch(file.patch);
    } catch (err) {
      console.warn(`AllFilesCodeView: skipping unparseable patch for ${file.path}`, err);
      continue;
    }
    const id = allocateId(file.path);
    fileDiff.cacheKey = `${id}#${patchHashes[index] ?? ''}`;
    const fileAnnotations = projectFileAnnotations(annotations, aiMessages, file.path, prUrl, prDiffScope, contextNotes, hostLineNotes);
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

/**
 * The diff a previewed Markdown file's item carries: the same file with no hunks, so Pierre draws
 * nothing under the header slot that holds the preview.
 */
function markdownPreviewFileDiff(full: FileDiffMetadata): FileDiffMetadata {
  return {
    ...full,
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    cacheKey: `${full.cacheKey ?? ''}#md-preview`,
  };
}

const SCROLLED_PAST_EPSILON_PX = 8;

type HeaderMetricsTarget = { setMetrics(metrics?: Partial<VirtualFileMetrics>, force?: boolean): void };
const isHeaderMetricsTarget = (value: unknown): value is HeaderMetricsTarget =>
  typeof value === 'object' && value !== null && typeof (value as HeaderMetricsTarget).setMetrics === 'function';

const PANEL_HEADER_HEIGHT = 33;
const COMPACT_PANEL_HEADER_HEIGHT = 44;
// Pierre's own 'line-info' default metric is also 32, so passing it is redundant today — kept
// explicit so the metric stays pinned to OUR unsafeCSS rule rather than silently tracking a library
// default.
const HUNK_SEPARATOR_HEIGHT = 32;
// The box holds the padding, so the code draws what the layout counts; under the last row only
// Pierre's own room for its sideways scrollbar (itemMetrics' paddingBottom).
const SCROLLS_WITH_PAGE_CSS = `
  [data-diffs-header] { container-type: scroll-state; container-name: sticky-header; }
  [data-expand-index] [data-separator-content] { justify-self: start; }
  :host([data-reading-whole-file]) [data-expand-button] { cursor: progress; animation: reading-whole-file 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
  @keyframes reading-whole-file { 50% { opacity: 0.5; } }
  @media (prefers-reduced-motion: reduce) { :host([data-reading-whole-file]) [data-expand-button] { animation: none; } }
`;
const STUCK_HEADER_LINE_CSS = `
  @container sticky-header scroll-state(stuck: top) {
    [data-diffs-header]::after { content: ''; position: absolute; left: 0; bottom: -1px; width: 100%; height: 1px; background: var(--border); }
  }
`;
const FLUSH_FILES_CSS = `
  :host([data-trailing-unread]) [data-separator][data-separator-last] { display: none; }
`;

// Slightly above Pierre's own post-interaction restore delay (120ms).
const AUGMENT_APPLY_IDLE_MS = 150;
const REVEAL_WAIT_MS = 30_000;

const EMPTY_AI_MESSAGES: AIChatEntry[] = [];
const EMPTY_CONTEXT_NOTES: readonly ContextNoteAnchor[] = [];
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
  hunkSeparators = 'line-info',
  fontFamily,
  fontSize,
  annotations,
  hostLineNotes = NO_HOST_LINE_NOTES,
  hostFileNotes = NO_HOST_FILE_NOTES,
  selectedAnnotationId,
  scrollTargetAnnotation,
  pendingSelection,
  reviewBase,
  reviewSnapshotId,
  contextExpansionAvailable = true,
  fetchFileContent,
  renderImagePreview,
  renderPackageChanges,
  markdownPreview,
  compactTouchLayout,
  onLineSelection,
  onAddAnnotationForFile,
  onEditAnnotation,
  onSelectAnnotation,
  onDeleteAnnotation,
  onExplainAnnotation,
  agentFindingSources,
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
  onTokenHoverEnter,
  onTokenHoverLeave,
  onTokenTarget,
  onVisibleFileChange,
  onFileScrolledPast,
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
  commentOnly = false,
  fileOpenIn,
  selectionActions,
  askOnly = false,
  aiAvailable = false,
  onAskAIForFile,
  isAILoading = false,
  onViewAIResponse,
  aiMessages = EMPTY_AI_MESSAGES,
  contextNotes = EMPTY_CONTEXT_NOTES,
  renderContextNote,
  onClickAIMarker,
  getAIHistoryForFile,
  allowScrollChaining = false,
  onContentHeightChange,
  flushFiles = false,
  headerKeepsFolder = false,
  scrollsWithPage = false,
  enableEditSuggestions = false,
  onAddSuggestionsForFile,
  onAddEditorCommentForFile,
}) => {
  const mountCollapsedRef = useRef(mountCollapsed);
  const seedCollapsed = mountCollapsedRef.current ?? defaultCollapsed;

  // With renderCustomHeader the built-in header runs in 'custom' mode (only the header-custom slot,
  // no [data-title] element), so that rule is moot either way — we keep `true` to be explicit that
  // the built-in title is irrelevant here (our FileHeader owns all header chrome).
  const pierreTheme = usePierreTheme({
    fontFamily,
    fontSize,
    showFileHeader: true,
    compactTouchLayout,
  });
  const workerPoolReady = useIsWorkerPoolReadyOrDisabled();
  useWorkerPoolThemeSync(pierreTheme.syntaxTheme);
  const viewerRef = useRef<CodeViewHandle<DiffAnnotationMetadata> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectionSnapshotRef = useRef<DiffSelectionSnapshot | null>(null);
  // State mirror of the scroll container so the leading-content portal can
  // mount once CodeView has rendered it (a plain ref can't trigger that).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollsWithPageRef = useRef(scrollsWithPage);
  const pageScrollRef = useRef<PageScroll | null>(null);
  const attachScrollContainer = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
    pageScrollRef.current?.undo();
    pageScrollRef.current = el && scrollsWithPageRef.current ? scrollWithPage(el) : null;
  }, []);
  const attachViewer = useCallback((viewer: CodeViewHandle<DiffAnnotationMetadata> | null) => {
    viewerRef.current =
      viewer && scrollsWithPageRef.current
        ? {
            ...viewer,
            scrollTo: (target) => {
              pageScrollRef.current?.expectJump();
              return viewer.scrollTo(target);
            },
          }
        : viewer;
  }, []);
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

  const contentHeightRef = useRef(onContentHeightChange);
  contentHeightRef.current = onContentHeightChange;
  const reportsContentHeight = !!onContentHeightChange;
  const [trailingUnread, setTrailingUnread] = useState(false);
  useEffect(() => {
    if (!scrollEl || !reportsContentHeight || typeof ResizeObserver === 'undefined') return;
    let last = -1;
    let list: Element | null = null;
    const report = () => {
      if (!list) return;
      const style = getComputedStyle(list);
      const height = Math.ceil((list as HTMLElement).offsetHeight + parseFloat(style.marginTop || '0') + parseFloat(style.marginBottom || '0')) - (trailingUnread ? HUNK_SEPARATOR_HEIGHT : 0);
      if (height <= 0 || height === last) return;
      last = height;
      contentHeightRef.current?.(height);
    };
    const sizes = new ResizeObserver(report);
    const bind = () => {
      const next = scrollEl.firstElementChild;
      if (next === list) return;
      if (list) sizes.unobserve(list);
      list = next;
      if (list) {
        sizes.observe(list);
        report();
      }
    };
    bind();
    const children = new MutationObserver(bind);
    children.observe(scrollEl, { childList: true });
    return () => {
      children.disconnect();
      sizes.disconnect();
    };
  }, [scrollEl, reportsContentHeight, trailingUnread]);

  const toolbarHostRef = useRef<ToolbarHostHandle>(null);

  // One global drag line spanning every file is noise on files where a split is meaningless
  // (new/deleted files), and the columns default to Pierre's even 1fr/1fr split.

  // The file path CodeView currently reports as visible (active-file highlight).
  // Reset on diff switch so stepping/highlighting never anchors on an old file.
  const visibleFileRef = useRef<string | null>(null);
  const visibleItemIdRef = useRef<string | null>(null);
  const passCandidateItemRef = useRef<string | null>(null);
  const hasScrolledRef = useRef(false);

  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const pendingToolbarRange = useRef<SelectedLineRange | null>(null);

  const [fileCommentAnchor, setFileCommentAnchor] = useState<{ el: HTMLElement; filePath: string } | null>(null);
  const fileCommentButtonRefs = useRef<Map<string, HTMLElement>>(new Map());

  const prevViewedRef = useRef<Set<string> | undefined>(viewedFiles);
  const prevStagedRef = useRef<Set<string> | undefined>(stagedFiles);
  const prevStagingRef = useRef<string | null | undefined>(stagingFile);
  const prevStageErrorRef = useRef<string | null | undefined>(stageError);
  const prevAnnotationsRef = useRef<CodeAnnotation[]>(annotations);
  const prevAIMessagesRef = useRef<AIChatEntry[]>(aiMessages);
  const prevContextNotesRef = useRef<readonly ContextNoteAnchor[]>(contextNotes);

  const kindOrderGenerated = fileOrder === 'kind' ? generatedFiles : undefined;
  const kindOrderKey = useMemo(
    () => (kindOrderGenerated ? [...kindOrderGenerated].sort().join('\n') : ''),
    [kindOrderGenerated],
  );
  const visualOrder = useMemo(() => {
    if (fileOrder === 'list') return files.map((_, index) => index);
    if (fileOrder === 'kind') return getFileKindOrder(files, kindOrderGenerated);
    const tree = buildFileTree(files);
    return getVisualFileOrder(tree);
    // The generated set is content-keyed (kindOrderKey): an equal set from a
    // refreshed payload must not reorder or remount anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, fileOrder, kindOrderKey]);

  // The identity (and the CodeView remount it drives via fileSetKey) must only change when the FILE
  // SET changes — otherwise every annotation add/edit/delete would remount the whole CodeView and
  // lose scroll/selection state.
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const aiMessagesRef = useRef(aiMessages);
  aiMessagesRef.current = aiMessages;
  const hostLineNotesRef = useRef(hostLineNotes);
  hostLineNotesRef.current = hostLineNotes;
  const contextNotesRef = useRef(contextNotes);
  contextNotesRef.current = contextNotes;
  const patchHashes = useMemo(() => files.map((f) => hashString(f.patch)), [files]);
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
      contextNotesRef.current,
      hostLineNotesRef.current,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, visualOrder, prUrl, prDiffScope, patchHashes, seedCollapsed, generatedKey],
  );
  const { filePathToItemId, filePathToItemIds, itemIdToFilePath, itemIdToFile } = identity;

  const imagePreviewItemIds = useMemo(() => {
    const ids = new Set<string>();
    if (renderImagePreview) {
      for (const [id, file] of itemIdToFile) {
        if (isImagePreviewCandidate(file.patch, file.path, file.oldPath)) ids.add(id);
      }
    }
    if (renderPackageChanges) {
      for (const [id, file] of itemIdToFile) if (packageFileKind(file.path)) ids.add(id);
    }
    return ids;
  }, [itemIdToFile, renderImagePreview, renderPackageChanges]);

  const markdownPreviewRef = useRef(markdownPreview);
  markdownPreviewRef.current = markdownPreview;
  const previewedPaths = markdownPreview?.previewedPaths;
  const isPreviewable = markdownPreview?.isPreviewable;
  const previewItemIds = useMemo(() => {
    const ids = new Set<string>();
    if (!previewedPaths || !isPreviewable) return ids;
    for (const [id, file] of itemIdToFile) {
      if (previewedPaths.has(file.path) && isPreviewable(file)) ids.add(id);
    }
    return ids;
  }, [itemIdToFile, previewedPaths, isPreviewable]);
  const previewItemIdsRef = useRef(previewItemIds);
  previewItemIdsRef.current = previewItemIds;

  const hostFileNotesByPath = useMemo(() => {
    const map = new Map<string, HostFileNote[]>();
    for (const note of hostFileNotes) {
      const list = map.get(note.filePath);
      if (list) list.push(note);
      else map.set(note.filePath, [note]);
    }
    return map;
  }, [hostFileNotes]);
  const hostFileNotesByPathRef = useRef(hostFileNotesByPath);
  hostFileNotesByPathRef.current = hostFileNotesByPath;
  const measuredHeaderItemIds = useMemo(() => {
    if (previewItemIds.size === 0 && hostFileNotesByPath.size === 0) return imagePreviewItemIds;
    const ids = new Set([...imagePreviewItemIds, ...previewItemIds]);
    for (const path of hostFileNotesByPath.keys()) for (const id of filePathToItemIds.get(path) ?? []) ids.add(id);
    return ids;
  }, [imagePreviewItemIds, previewItemIds, hostFileNotesByPath, filePathToItemIds]);
  const imagePreviewItemIdsRef = useRef(measuredHeaderItemIds);
  imagePreviewItemIdsRef.current = measuredHeaderItemIds;

  const fullDiffsRef = useRef(new Map<string, FileDiffMetadata>());
  const previewAppliedRef = useRef(new Set<string>());
  const fileSetKey = useMemo(
    // prUrl/prDiffScope are part of the key so a pure scope switch (layer ↔ full-stack, same file
    // set) remounts and re-seeds annotations through the current scope filter — the incremental
    // sync bails on an unchanged annotations ref and can't otherwise detect the filter change.
    // fileOrder is part of the key:
    () => `${fileOrder ?? 'tree'}:${seedCollapsed ? 'c' : 'e'}:g${generatedKey ? hashString(generatedKey) : ''}:${prUrl ?? ''}:${prDiffScope ?? ''}:${reviewSnapshotId ?? ''}:${files.length}:${files.map((f, i) => `${f.path}#${patchHashes[i]}`).join('|')}`,
    [files, patchHashes, prUrl, prDiffScope, reviewSnapshotId, fileOrder, seedCollapsed, generatedKey],
  );

  const seededPreviewKeyRef = useRef<string | null>(null);
  if (seededPreviewKeyRef.current !== fileSetKey) {
    seededPreviewKeyRef.current = fileSetKey;
    fullDiffsRef.current = new Map();
    previewAppliedRef.current = new Set();
    for (const item of identity.items) {
      if (item.type !== 'diff' || !previewItemIds.has(item.id)) continue;
      fullDiffsRef.current.set(item.id, item.fileDiff);
      item.fileDiff = markdownPreviewFileDiff(item.fileDiff);
      previewAppliedRef.current.add(item.id);
    }
  }

  const orderedItemIds = useMemo(
    () => identity.items.map((item) => item.id),
    [identity.items],
  );

  const activePatch = useMemo(
    () => (activeFilePath ? files.find((f) => f.path === activeFilePath)?.patch ?? '' : ''),
    [files, activeFilePath],
  );

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

  const matchesByItemIdRef = useRef(matchesByItemId);
  matchesByItemIdRef.current = matchesByItemId;
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const activeSearchMatchIdRef = useRef(activeSearchMatchId);
  activeSearchMatchIdRef.current = activeSearchMatchId;

  // If the toolbar is already keyed to this file, open immediately; otherwise activate the file
  // first and defer until ToolbarHost remounts against its patch.
  const routeSelectionToToolbar = useCallback(
    (range: SelectedLineRange, filePath: string) => {
      if (activeFilePath === filePath) {
        toolbarHostRef.current?.handleLineSelectionEnd(range);
      } else {
        pendingToolbarRange.current = range;
        setActiveFilePath(filePath);
        const itemId = filePathToItemId.get(filePath);
        if (itemId != null) setSelectedLines({ id: itemId, range });
        onLineSelection(range);
      }
    },
    [activeFilePath, onLineSelection, filePathToItemId],
  );

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

  const handleEditAnnotation = useStableCallback((id: string) => {
    const ann = annotationsRef.current.find((a) => a.id === id);
    if (!ann) return;
    toolbarHostRef.current?.startEdit(ann);
  });
  const handleExplainAnnotation = useStableCallback((id: string) => onExplainAnnotation?.(id));
  const explainHandler = onExplainAnnotation ? handleExplainAnnotation : undefined;

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

  const renderAnnotation = useStableCallback(
    (...[annotation, , item]: CodeViewAnnotationArgs<DiffAnnotationMetadata>) => {
      if (!('side' in annotation) || item.type !== 'diff') return null;
      if (!annotation.metadata) return null;
      if (annotation.metadata.kind === 'host-note') {
        const id = annotation.metadata.annotationId;
        return hostLineNotesRef.current.find((note) => note.id === id)?.render() ?? null;
      }
      if (annotation.metadata.kind === 'context-note') {
        const id = annotation.metadata.contextNoteId;
        const drawn = id && renderContextNote ? renderContextNote(id) : null;
        return drawn ? <div className="context-note-slot" data-context-note={id}>{drawn}</div> : null;
      }
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
          onExplain={explainHandler}
          agentFindingSources={agentFindingSources}
          explainDisabled={isAILoading}
        />
      );
    },
  );

  useEffect(() => {
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
    visibleItemIdRef.current = null;
    passCandidateItemRef.current = null;
    hasScrolledRef.current = false;
    // An edit session cannot survive the CodeView remount (Pierre tears the editor down without a
    // completion callback), and fileSetKey also changes on sort-order / collapse-default flips, not
    // just diff switches.
    editSession.handleFileSetChange();
    // A pending editor-selection comment entry is anchored to the OLD diff's
    // pristine coordinates — stale once the file set changes.
    setSelectionAnnotationRequest(null);
    setFileCommentAnchor(null);
    fileCommentButtonRefs.current.clear();
    prevViewedRef.current = viewedFiles;
    prevStagedRef.current = stagedFiles;
    prevStagingRef.current = stagingFile;
    prevStageErrorRef.current = stageError;
    prevAnnotationsRef.current = annotations;
    prevAIMessagesRef.current = aiMessages;
    prevContextNotesRef.current = contextNotes;
    for (const [itemId, entry] of augmentRef.current) {
      if (entry.generation === fileSetKey) continue;
      entry.controller.abort();
      augmentRef.current.delete(itemId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSetKey]);

  const [allCollapsed, setAllCollapsed] = useState(seedCollapsed === true);

  useEffect(() => setAllCollapsed(seedCollapsed === true), [identity.items, seedCollapsed]);

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
    if (generatedFiles?.has(filePath)) onGeneratedFileCollapsedChange?.(filePath, collapsed);
  });

  const toggleItemCollapsed = useStableCallback((itemId: string) => {
    const handle = viewerRef.current;
    const viewer = handle?.getInstance();
    const item = handle?.getItem(itemId);
    if (handle == null || viewer == null || item == null) return;

    // Collapsing a file that is mid-edit ends its session first (Pierre would otherwise end it
    // implicitly; routing through finishIfEditing keeps the suggestion capture + pristine restore
    // on our one code path).
    if (item.collapsed !== true) editSession.finishIfEditing(itemId);

    // If the item top is above scrollTop, re-anchor after the update so the collapsing file stays
    // in view (it would otherwise shift the content below it upward, jumping the scroll).
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

  useEffect(() => {
    registerCollapseAllToggle?.(handleToggleAllCollapsed);
    return () => registerCollapseAllToggle?.(null);
  }, [registerCollapseAllToggle, handleToggleAllCollapsed]);
  useEffect(() => {
    onAllCollapsedChange?.(allCollapsed);
  }, [onAllCollapsedChange, allCollapsed]);

  // Force CodeView to re-render an item's slots (header included) WITHOUT otherwise mutating it.
  const refreshItem = useCallback((itemId: string) => {
    const handle = viewerRef.current;
    const item = handle?.getItem(itemId);
    if (handle == null || item == null) return;
    item.version = (item.version ?? 0) + 1;
    handle.updateItem(item);
  }, []);

  const itemMetricsRef = useRef<Partial<VirtualFileMetrics>>({});
  const measuredHeaderHeightsRef = useRef(new Map<string, number>());
  const headerMetricsInstancesRef = useRef(new Map<string, HeaderMetricsTarget>());
  const appliedHeaderMetricsRef = useRef(
    new WeakMap<HeaderMetricsTarget, { height: number; base: Partial<VirtualFileMetrics> }>(),
  );

  const syncHeaderMetrics = useCallback(
    (itemId: string) => {
      const instance = headerMetricsInstancesRef.current.get(itemId);
      if (instance == null) return;
      const base = itemMetricsRef.current;
      const baseHeight = base.diffHeaderHeight ?? DEFAULT_CODE_VIEW_FILE_METRICS?.diffHeaderHeight ?? 0;
      const height = measuredHeaderHeightsRef.current.get(itemId) ?? baseHeight;
      const applied = appliedHeaderMetricsRef.current.get(instance);
      if (applied ? applied.height === height && applied.base === base : height === baseHeight) return;
      instance.setMetrics({ ...DEFAULT_CODE_VIEW_FILE_METRICS, ...base, diffHeaderHeight: height });
      appliedHeaderMetricsRef.current.set(instance, { height, base });
      refreshItem(itemId);
    },
    [refreshItem],
  );

  const headerMeasureRefs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const headerObserversRef = useRef(new Map<string, ResizeObserver>());
  const getHeaderMeasureRef = useCallback(
    (itemId: string) => {
      let callback = headerMeasureRefs.current.get(itemId);
      if (callback) return callback;
      callback = (el: HTMLElement | null) => {
        headerObserversRef.current.get(itemId)?.disconnect();
        headerObserversRef.current.delete(itemId);
        if (el == null || typeof ResizeObserver === 'undefined') return;
        const report = () => {
          const height = Math.ceil(el.getBoundingClientRect().height);
          if (height <= 0) return;
          const baseHeight = itemMetricsRef.current.diffHeaderHeight ?? 0;
          if (height === baseHeight) measuredHeaderHeightsRef.current.delete(itemId);
          else measuredHeaderHeightsRef.current.set(itemId, height);
          syncHeaderMetrics(itemId);
        };
        const observer = new ResizeObserver(report);
        observer.observe(el);
        headerObserversRef.current.set(itemId, observer);
        report();
      };
      headerMeasureRefs.current.set(itemId, callback);
      return callback;
    },
    [syncHeaderMetrics],
  );

  useEffect(() => {
    const observers = headerObserversRef.current;
    return () => {
      for (const observer of observers.values()) observer.disconnect();
      observers.clear();
    };
  }, []);

  const augmentRef = useRef<
    Map<
      string,
      { status: 'pending' | 'done' | 'error'; controller: AbortController; generation: string }
    >
  >(new Map());
  // reviewBase / itemIdToFile / fileSetKey read through refs so the stable onPostRender callback
  // always sees the latest values without changing identity (which would otherwise churn the
  // CodeView options object).
  const reviewBaseRef = useRef(reviewBase);
  reviewBaseRef.current = reviewBase;
  const reviewSnapshotIdRef = useRef(reviewSnapshotId);
  reviewSnapshotIdRef.current = reviewSnapshotId;
  const contextExpansionAvailableRef = useRef(contextExpansionAvailable);
  contextExpansionAvailableRef.current = contextExpansionAvailable;
  const fetchFileContentRef = useRef(fetchFileContent);
  fetchFileContentRef.current = fetchFileContent;
  const itemIdToFileRef = useRef(itemIdToFile);
  itemIdToFileRef.current = itemIdToFile;
  const fileSetKeyRef = useRef(fileSetKey);
  fileSetKeyRef.current = fileSetKey;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const editEnabled = enableEditSuggestions && onAddSuggestionsForFile != null;
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
  const refreshEditSessionMarkers = editSession.refreshMarkers;
  useEffect(() => {
    refreshEditSessionMarkers();
  }, [annotations, refreshEditSessionMarkers]);

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

  const augmentItem = useCallback((itemId: string) => {
    if (fetchFileContentRef.current) return;
    const augmentState = augmentRef.current;
    const generation = fileSetKeyRef.current;
    const existing = augmentState.get(itemId);
    if (existing) {
      if (existing.generation === generation) return;
      existing.controller.abort();
    }

    const file = itemIdToFileRef.current.get(itemId);
    if (file == null) return;

    const controller = new AbortController();

    if (readOnlyRef.current || !contextExpansionAvailableRef.current) {
      augmentState.set(itemId, { status: 'done', controller, generation });
      return;
    }
    augmentState.set(itemId, { status: 'pending', controller, generation });

    const isStale = () =>
      controller.signal.aborted || fileSetKeyRef.current !== generation;

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
          augmentState.set(itemId, { status: 'done', controller, generation });
          return;
        }

        // Stale-content guard: the file may have changed on disk since this
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

        queueAugmentApply(itemId, () => {
          if (isStale()) return;
          const liveHandle = viewerRef.current;
          const item = liveHandle?.getItem(itemId);
          if (liveHandle == null || item == null || item.type !== 'diff') {
            augmentState.set(itemId, { status: 'done', controller, generation });
            return;
          }
          if (itemId === editSession.editingItemIdRef.current) {
            augmentState.set(itemId, { status: 'done', controller, generation });
            return;
          }

          augmented.cacheKey = `${generation}::${itemId}#full`;
          if (previewAppliedRef.current.has(itemId)) {
            fullDiffsRef.current.set(itemId, augmented);
            augmentState.set(itemId, { status: 'done', controller, generation });
            return;
          }
          item.fileDiff = augmented;
          item.version = (item.version ?? 0) + 1;
          liveHandle.updateItem(item);
          augmentState.set(itemId, { status: 'done', controller, generation });
        });
      })
      .catch((err) => {
        if (isStale()) {
          if (augmentState.get(itemId)?.controller === controller) {
            augmentState.delete(itemId);
          }
          return;
        }
        augmentState.set(itemId, { status: 'error', controller, generation });
        void err;
      });
  }, [queueAugmentApply]);

  const [wholeFileGone, setWholeFileGone] = useState(false);
  const wholeFileGoneRef = useRef(wholeFileGone);
  wholeFileGoneRef.current = wholeFileGone;
  useEffect(() => setWholeFileGone(false), [fileSetKey]);
  const wholeFileFailedRef = useRef(0);
  const loadWholeFile = useStableCallback((fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const generation = fileSetKeyRef.current;
    const entry = [...itemIdToFileRef.current].find(([, candidate]) => candidate.path === fileDiff.name);
    const read = fetchFileContentRef.current;
    // No text to open: no arrows, and a promise that stays open, since Pierre logs a rejection and throws on an empty answer.
    const none = () => {
      if (fileSetKeyRef.current === generation) setWholeFileGone(true);
      return new Promise<never>(() => {});
    };
    if (!entry || !read) return none();
    const [itemId, file] = entry;
    const controller = new AbortController();
    augmentRef.current.get(itemId)?.controller.abort();
    augmentRef.current.set(itemId, { status: 'pending', controller, generation });
    const shown = viewerRef.current?.getInstance()?.getRenderedItems().find((candidate) => candidate.id === itemId)?.element;
    shown?.setAttribute('data-reading-whole-file', '');
    return read(file, controller.signal).finally(() => shown?.removeAttribute('data-reading-whole-file')).then(
      (data) => {
        augmentRef.current.set(itemId, { status: 'done', controller, generation });
        if (data?.oldContent == null || data.newContent == null) return none();
        if (!isContentConsistentWithPatch(file.patch, data.oldContent, data.newContent)) return none();
        return {
          oldFile: { name: file.oldPath || file.path, contents: data.oldContent },
          newFile: { name: file.path, contents: data.newContent },
        };
      },
      // The read failed: the arrows stay, and Pierre's next click asks again. Nobody is waiting on one this view let go of.
      (cause: unknown) => {
        augmentRef.current.set(itemId, { status: 'done', controller, generation });
        if (controller.signal.aborted || fileSetKeyRef.current !== generation) return new Promise<never>(() => {});
        wholeFileFailedRef.current += 1;
        throw cause;
      },
    );
  });
  const opensWholeFiles = !!fetchFileContent && !wholeFileGone && files.some((file) => file.status === 'modified' || file.status === 'renamed');
  // Flush, one file per viewer (the PR page): while its whole text is unread, Pierre would close
  // the file with a "More unchanged context may be available" row (a loader, a partial diff).
  const flushesFiles = flushFiles && scrollsWithPage && files.length === 1;
  const hidesTrailingRow = (item: CodeViewItem<DiffAnnotationMetadata>) =>
    item.type === 'diff' &&
    opensWholeFiles &&
    item.collapsed !== true &&
    item.fileDiff.isPartial &&
    (item.fileDiff.type === 'change' || item.fileDiff.type === 'rename-changed') &&
    item.fileDiff.hunks.length > 0;
  const syncTrailingRow = (node: HTMLElement, item: CodeViewItem<DiffAnnotationMetadata>) => {
    const unread = hidesTrailingRow(item);
    node.toggleAttribute('data-trailing-unread', unread);
    setTrailingUnread(unread);
  };

  const revealClosedLines = useStableCallback((itemId: string, ann: CodeAnnotation, range: SelectedLineRange, onDone: () => void): (() => void) | null => {
    const file = itemIdToFileRef.current.get(itemId);
    const side = range.side === 'deletions' ? 'old' : 'new';
    if (!file || !fetchFileContentRef.current || isFileScopedAnnotation(ann)) return null;
    if (isLineRangeInPatch(file.patch, Math.min(range.start, range.end), Math.max(range.start, range.end), side)) return null;
    let frame = 0;
    let asked = false;
    const failures = wholeFileFailedRef.current;
    const deadline = performance.now() + REVEAL_WAIT_MS;
    const step = () => {
      const viewer = viewerRef.current?.getInstance();
      const rendered = viewer?.getRenderedItems().find((candidate) => candidate.id === itemId);
      const instance = rendered?.type === 'diff' ? rendered.instance : null;
      const fileDiff = rendered?.type === 'diff' ? rendered.item.fileDiff : null;
      if (wholeFileGoneRef.current || wholeFileFailedRef.current !== failures || performance.now() > deadline) return onDone();
      if (instance && fileDiff && !fileDiff.isPartial) {
        for (const line of [range.start, range.end]) instance.revealLine(newLineOf(fileDiff, line, side));
        return onDone();
      }
      if (instance && fileDiff && !asked) {
        asked = true;
        instance.expandHunk(0, 'up', 0);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  });

  const applyItemHighlights = useCallback((node: HTMLElement, itemId: string) => {
    const matches = matchesByItemIdRef.current.get(itemId) ?? [];
    applyItemSearchHighlights(node, searchQueryRef.current, matches, activeSearchMatchIdRef.current);
  }, []);

  // We ride CodeView's existing virtualization rather than layering our own observer on top (which
  // would double-virtualize and fight the element pool).
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
      if (imagePreviewItemIdsRef.current.has(context.id) && isHeaderMetricsTarget(_instance)) {
        headerMetricsInstancesRef.current.set(context.id, _instance);
        syncHeaderMetrics(context.id);
      }
      nodeToItemIdRef.current.set(node, context.id);
      if (flushesFiles) syncTrailingRow(node, context);
      augmentItem(context.id);
      const itemId = context.id;
      requestAnimationFrame(() => applyItemHighlights(node, itemId));
    },
  );

  const handleContentTextSelection = useStableCallback(() => {
    requestAnimationFrame(() => {
      const root = scrollRef.current;
      const selection = getDiffSelection(root);
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
      const anchorLine = getLineNumberFromNode(selection.anchorNode);
      const focusLine = getLineNumberFromNode(selection.focusNode);
      if (anchorLine == null || focusLine == null) return;
      if (anchorLine === focusLine) return;
      const rootNode = selection.anchorNode?.getRootNode();
      const host = rootNode instanceof ShadowRoot ? rootNode.host : null;
      const itemId = host instanceof HTMLElement ? nodeToItemIdRef.current.get(host) : undefined;
      if (itemId == null) return;
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

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    const onPointerDown = () => {
      if (clearTimer) {
        clearTimeout(clearTimer);
        clearTimer = null;
      }
      selectionSnapshotRef.current = snapshotDiffSelection(root);
    };
    const onCancel = () => {
      selectionSnapshotRef.current = null;
    };
    const onPointerUp = () => {
      clearTimer = setTimeout(() => {
        selectionSnapshotRef.current = null;
      }, 200);
    };
    root.addEventListener('pointerdown', onPointerDown, true);
    root.addEventListener('pointercancel', onCancel, true);
    root.addEventListener('pointerup', onPointerUp, true);
    const handler = () => handleContentTextSelection();
    root.addEventListener('mouseup', handler, true);
    return () => {
      if (clearTimer) clearTimeout(clearTimer);
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('pointercancel', onCancel, true);
      root.removeEventListener('pointerup', onPointerUp, true);
      root.removeEventListener('mouseup', handler, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSetKey]);

  useEffect(() => {
    const augmentState = augmentRef.current;
    return () => {
      for (const { controller } of augmentState.values()) controller.abort();
      augmentState.clear();
    };
  }, []);

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

  useEffect(() => {
    const container = scrollRef.current;
    if (container == null) return;
    swapActiveSearchHighlight(container, activeSearchMatchId);
  }, [activeSearchMatchId]);

  useEffect(() => {
    const handle = viewerRef.current;
    if (handle == null) return;
    const applied = previewAppliedRef.current;
    for (const { id } of identity.items) {
      const want = previewItemIds.has(id);
      if (want === applied.has(id)) continue;
      const item = handle.getItem(id);
      if (item == null || item.type !== 'diff') continue;
      if (want) {
        // Never swap the document out from under an edit session.
        if (id === editSession.editingItemIdRef.current) continue;
        fullDiffsRef.current.set(id, item.fileDiff);
        item.fileDiff = markdownPreviewFileDiff(item.fileDiff);
        applied.add(id);
      } else {
        const full = fullDiffsRef.current.get(id);
        if (full) item.fileDiff = full;
        fullDiffsRef.current.delete(id);
        applied.delete(id);
        measuredHeaderHeightsRef.current.delete(id);
      }
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
      if (!want) syncHeaderMetrics(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewItemIds, identity, editSession.editingItemId]);

  const activeMatchItemId = activeSearchMatch != null ? filePathToItemId.get(activeSearchMatch.filePath) ?? '' : '';
  const activeMatchPreviewed = activeSearchMatch != null
    && previewItemIds.has(activeMatchItemId)
    && activeMatchItemId !== editSession.editingItemId;

  useEffect(() => {
    if (!isActive) return;
    if (activeSearchMatch == null) return;
    const itemId = filePathToItemId.get(activeSearchMatch.filePath);
    if (itemId == null) return;
    if (activeMatchPreviewed) {
      markdownPreviewRef.current?.show(activeSearchMatch.filePath, 'source');
      return;
    }
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

    const side: 'additions' | 'deletions' =
      activeSearchMatch.side === 'deletion' ? 'deletions' : 'additions';
    const lineNumber = activeSearchMatch.lineNumber;
    const raf = requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (viewer == null) return;
      viewer.scrollTo({ type: 'line', id: itemId, lineNumber, side, align: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeSearchMatch, filePathToItemId, isActive, syncAllCollapsedMirror, reportFileCollapsed, activeMatchPreviewed]);

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
        contextNotesRef.current,
        hostLineNotesRef.current,
      );
      item.version = (item.version ?? 0) + 1;
      handle.updateItem(item);
    },
    [prUrl, prDiffScope],
  );

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

  useEffect(() => {
    const handle = viewerRef.current;
    const prev = prevAIMessagesRef.current;
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

  const prevHostLineNotesRef = useRef(hostLineNotes);
  useEffect(() => {
    const handle = viewerRef.current;
    const prev = prevHostLineNotesRef.current;
    if (handle == null) return;
    prevHostLineNotesRef.current = hostLineNotes;
    if (prev === hostLineNotes) return;
    const nextSig = hostLineNoteSignatures(hostLineNotes);
    const prevSig = hostLineNoteSignatures(prev);
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
  }, [hostLineNotes, annotations, aiMessages, filePathToItemIds, syncItemAnnotations, workerPoolReady]);

  const prevHostFileNotesRef = useRef(hostFileNotes);
  useEffect(() => {
    const handle = viewerRef.current;
    const prev = prevHostFileNotesRef.current;
    if (handle == null) return;
    prevHostFileNotesRef.current = hostFileNotes;
    if (prev === hostFileNotes) return;
    const nextSig = hostFileNoteSignatures(hostFileNotes);
    const prevSig = hostFileNoteSignatures(prev);
    const changedPaths = new Set<string>();
    nextSig.forEach((sig, path) => {
      if (prevSig.get(path) !== sig) changedPaths.add(path);
    });
    prevSig.forEach((_sig, path) => {
      if (!nextSig.has(path)) changedPaths.add(path);
    });
    for (const path of changedPaths) {
      for (const itemId of filePathToItemIds.get(path) ?? []) {
        if (!nextSig.has(path) && !imagePreviewItemIdsRef.current.has(itemId)) {
          measuredHeaderHeightsRef.current.delete(itemId);
          syncHeaderMetrics(itemId);
        }
        refreshItem(itemId);
      }
    }
  }, [hostFileNotes, filePathToItemIds, refreshItem, syncHeaderMetrics, workerPoolReady]);

  useEffect(() => {
    const handle = viewerRef.current;
    const prev = prevContextNotesRef.current;
    if (handle == null) return;
    prevContextNotesRef.current = contextNotes;
    if (prev === contextNotes) return;
    const sig = (list: readonly ContextNoteAnchor[]) => {
      const map = new Map<string, string>();
      for (const n of list) map.set(n.filePath, `${map.get(n.filePath) ?? ''}${n.id}:${n.side}:${n.lineStart}-${n.lineEnd}\n`);
      return map;
    };
    const before = sig(prev);
    const after = sig(contextNotes);
    const changedPaths = new Set<string>();
    after.forEach((s, path) => {
      if (before.get(path) !== s) changedPaths.add(path);
    });
    before.forEach((_s, path) => {
      if (!after.has(path)) changedPaths.add(path);
    });
    for (const path of changedPaths) {
      for (const itemId of filePathToItemIds.get(path) ?? []) {
        syncItemAnnotations(path, itemId, annotations, aiMessages);
      }
    }
  }, [contextNotes, annotations, aiMessages, filePathToItemIds, syncItemAnnotations, workerPoolReady]);

  const handleToggleViewedAndCollapse = useStableCallback((filePath: string, itemId: string) => {
    const wasViewed = viewedFiles?.has(filePath) ?? false;
    onToggleViewed?.(filePath);
    // Un-viewing performs no collapse, so it would otherwise skip the version bump and leave the
    // (now stale) Viewed badge on screen — force a header refresh so the Viewed button reverts both
    // ways.
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

  // Header chrome (Viewed badge, staging spinner / Added checkmark, stage-error text) is driven by
  // external React props, but the custom header is rendered into Pierre's slot portal which only
  // republishes on updateItem — never when a stable render callback's captured props change.
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
    if (stagingFile !== prevStagingRef.current) {
      if (stagingFile) changedPaths.add(stagingFile);
      if (prevStagingRef.current) changedPaths.add(prevStagingRef.current);
    }
    if (stageError !== prevStageErrorRef.current) {
      if (stagingFile) changedPaths.add(stagingFile);
      if (prevStagingRef.current) changedPaths.add(prevStagingRef.current);
    }

    prevViewedRef.current = viewedFiles;
    prevStagedRef.current = stagedFiles;
    prevStagingRef.current = stagingFile;
    prevStageErrorRef.current = stageError;

    for (const path of changedPaths) {
      for (const itemId of filePathToItemIds.get(path) ?? []) {
        refreshItem(itemId);
      }
    }
  }, [viewedFiles, stagedFiles, stagingFile, stageError, filePathToItemIds, refreshItem]);

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

  const explainKey = onExplainAnnotation
    ? `${isAILoading}|${[...(agentFindingSources ?? [])].join('\0')}`
    : '';
  const prevExplainKeyRef = useRef(explainKey);
  useEffect(() => {
    if (prevExplainKeyRef.current === explainKey) return;
    prevExplainKeyRef.current = explainKey;
    const paths = new Set<string>();
    for (const a of annotationsRef.current) if (a.source && a.filePath) paths.add(a.filePath);
    for (const path of paths) {
      for (const itemId of filePathToItemIds.get(path) ?? []) refreshItem(itemId);
    }
  }, [explainKey, filePathToItemIds, refreshItem]);

  const handleSelectedLinesChange = useStableCallback(
    (selection: CodeViewLineSelection | null) => {
      setSelectedLines(selection);
      onLineSelection(selection ? selection.range : null);
    },
  );

  const selectedLinesRef = useRef(selectedLines);
  selectedLinesRef.current = selectedLines;

  const lineSelectionForAnnotation = useStableCallback(
    (ann: CodeAnnotation | null | undefined): CodeViewLineSelection | null => {
      if (!ann || isFileScopedAnnotation(ann)) return null;
      const itemId = filePathToItemId.get(ann.filePath);
      return itemId != null ? { id: itemId, range: lineRangeForAnnotation(ann) } : null;
    },
  );
  const selectedAnnotationIdRef = useRef(selectedAnnotationId);
  selectedAnnotationIdRef.current = selectedAnnotationId;
  useEffect(() => {
    if (pendingSelection == null) {
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
      return;
    }
    const owner = activeFilePath ?? (filePathToItemId.size === 1 ? [...filePathToItemId.keys()][0]! : null);
    if (owner) {
      const itemId = filePathToItemId.get(owner);
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
      const snapshot = selectionSnapshotRef.current;
      selectionSnapshotRef.current = null;
      let effectiveRange = range;
      if (snapshot) {
        const snapshotItemId = snapshot.host ? nodeToItemIdRef.current.get(snapshot.host) : undefined;
        if (!snapshot.host || !snapshotItemId || snapshotItemId === item.id) {
          effectiveRange = rangeForGutterClick(range, snapshot);
        }
      }
      handleLineSelectionInteraction('gutter-comment-action', effectiveRange, item);
    },
  );

  const handleTokenClick = useStableCallback(
    (props: DiffTokenEventBaseProps, event: MouseEvent, item: CodeViewItem<DiffAnnotationMetadata>) => {
      if (onTokenTarget && item.type === 'diff') {
        const clickedPath = itemIdToFilePath.get(item.id);
        if (clickedPath != null) onTokenTarget('click', props, clickedPath);
      }
      if (!onCodeNavRequest || item.type !== 'diff') return;
      if (!(event.metaKey || event.ctrlKey || event.altKey)) return;
      const filePath = itemIdToFilePath.get(item.id);
      if (filePath == null) return;
      onCodeNavRequest(buildCodeNavRequest(props, filePath));
    },
  );

  const handleTokenEnter = useStableCallback(
    (props: DiffTokenEventBaseProps, event: PointerEvent, item: CodeViewItem<DiffAnnotationMetadata>) => {
      if (onCodeNavRequest && (event.metaKey || event.ctrlKey)) {
        props.tokenElement.classList.add('pn-token-nav');
      }
      if (onTokenTarget && item.type === 'diff') {
        const pointedPath = itemIdToFilePath.get(item.id);
        if (pointedPath != null) onTokenTarget('enter', props, pointedPath);
      }
      if (!onTokenHoverEnter || item.type !== 'diff') return;
      props.tokenElement.classList.add('pn-token-hover');
      // File identity comes from the owning item, exactly as handleTokenClick
      // resolves it — never from an active-file side channel.
      const filePath = itemIdToFilePath.get(item.id);
      if (filePath == null) return;
      onTokenHoverEnter(props, filePath);
    },
  );

  const handleTokenLeave = useStableCallback((props: DiffTokenEventBaseProps) => {
    props.tokenElement.classList.remove('pn-token-nav');
    props.tokenElement.classList.remove('pn-token-hover');
    onTokenTarget?.('leave', props, '');
    onTokenHoverLeave?.();
  });

  const reportVisibleFile = useStableCallback(() => {
    const viewer = viewerRef.current?.getInstance();
    if (viewer == null) return;
    const rendered = viewer.getRenderedItems();
    if (rendered.length === 0) return;
    const scrollTop = viewer.getScrollTop();
    const isCollapsed = (itemId: string) => viewerRef.current?.getItem(itemId)?.collapsed === true;
    let bestId = rendered[0].id;
    for (const renderedItem of rendered) {
      const top = viewer.getTopForItem(renderedItem.id);
      if (top == null) continue;
      if (top <= scrollTop + 50) bestId = renderedItem.id;
    }
    const atBottom =
      viewer.getScrollTop() + viewer.getHeight() >= viewer.getScrollHeight() - 2;
    if (atBottom) {
      bestId = rendered[rendered.length - 1].id;
    }
    const path = itemIdToFilePath.get(bestId) ?? null;
    if (path !== visibleFileRef.current) {
      const previousItemId = visibleItemIdRef.current;
      if (previousItemId != null && previousItemId !== bestId) {
        passCandidateItemRef.current = previousItemId;
      }
      visibleItemIdRef.current = bestId;
      visibleFileRef.current = path;
      onVisibleFileChange?.(path, { collapsed: isCollapsed(bestId) });
    }
    // An upward move (or a return to the candidate itself) drops it: going back is not moving on.
    if (onFileScrolledPast && passCandidateItemRef.current != null) {
      const candidateId = passCandidateItemRef.current;
      const candidateIndex = orderedItemIds.indexOf(candidateId);
      const currentIndex = orderedItemIds.indexOf(bestId);
      const candidatePath = itemIdToFilePath.get(candidateId);
      if (candidateIndex === -1 || candidatePath == null || currentIndex <= candidateIndex
          || isCollapsed(candidateId)) {
        passCandidateItemRef.current = null;
      } else {
        const successorTop = viewer.getTopForItem(orderedItemIds[candidateIndex + 1]);
        if (successorTop != null && successorTop <= scrollTop + SCROLLED_PAST_EPSILON_PX) {
          passCandidateItemRef.current = null;
          onFileScrolledPast(candidatePath);
        }
      }
    }
    if (atBottom && hasScrolledRef.current && path != null && onFileScrolledPast
        && !isCollapsed(bestId)) {
      onFileScrolledPast(path);
    }
  });

  const scrollReportRafRef = useRef<number | null>(null);
  const handleScroll = useStableCallback((position: number) => {
    lastScrollTsRef.current = Date.now();
    hasScrolledRef.current = true;
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

  // Re-runs on `fileSetKey` because a diff switch remounts CodeView, so the new diff's first file
  // must be re-reported as the active file.
  useEffect(() => {
    const raf = requestAnimationFrame(() => reportVisibleFile());
    return () => cancelAnimationFrame(raf);
  }, [reportVisibleFile, fileSetKey]);

  const hasRestoredInitialScrollRef = useRef(false);
  useEffect(() => {
    if (hasRestoredInitialScrollRef.current || initialScrollPosition <= 0) return;
    hasRestoredInitialScrollRef.current = true;
    const raf = requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({ type: 'position', position: initialScrollPosition });
    });
    return () => cancelAnimationFrame(raf);
  }, [fileSetKey, initialScrollPosition]);

  const scrollToItem = useCallback((itemId: string) => {
    const viewer = viewerRef.current;
    if (viewer == null) return;
    viewer.scrollTo({ type: 'item', id: itemId, align: 'start' });
  }, []);

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
      if (!scrollsWithPageRef.current) handle.scrollTo({ type: 'item', id: itemId, align: 'start' });
    });
    return () => cancelAnimationFrame(raf);
  }, [fileScrollTarget?.filePath, fileScrollTarget?.token, fileSetKey, filePathToItemId, syncAllCollapsedMirror, reportFileCollapsed]);

  const pendingSelectionRef = useRef(pendingSelection);
  pendingSelectionRef.current = pendingSelection;
  const prevSelectedFileRef = useRef<string | null>(null);
  useEffect(() => {
    const ann = selectedAnnotationId
      ? annotationsRef.current.find((a) => a.id === selectedAnnotationId)
      : null;
    const newFile = ann?.filePath ?? null;

    const filesToRefresh = new Set<string>();
    if (prevSelectedFileRef.current) filesToRefresh.add(prevSelectedFileRef.current);
    if (newFile) filesToRefresh.add(newFile);
    prevSelectedFileRef.current = newFile;
    for (const path of filesToRefresh) {
      for (const itemId of filePathToItemIds.get(path) ?? []) refreshItem(itemId);
    }

    if (pendingSelectionRef.current != null) return;

    setSelectedLines(lineSelectionForAnnotation(ann));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAnnotationId, filePathToItemId, filePathToItemIds, refreshItem]);

  const handledScrollTargetRef = useRef<AnnotationScrollTarget | null>(null);
  useEffect(() => {
    if (!scrollTargetAnnotation) return;
    if (handledScrollTargetRef.current === scrollTargetAnnotation) return;
    const ann = annotationsRef.current.find((a) => a.id === scrollTargetAnnotation.id);
    if (!ann) return;
    const itemId = filePathToItemId.get(ann.filePath);
    const handle = viewerRef.current;
    if (itemId == null || handle == null) return;
    const previewControl = markdownPreviewRef.current;
    const previewed = previewItemIdsRef.current.has(itemId);
    if (previewControl && ann.markdownPreview && !previewed) {
      previewControl.show(ann.filePath, ann.markdownPreview.view === 'whole' ? 'read' : 'changes');
      return;
    }
    if (previewControl && previewed && !isFileScopedAnnotation(ann)) {
      previewControl.show(ann.filePath, 'source');
      return;
    }
    handledScrollTargetRef.current = scrollTargetAnnotation;

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
    let raf = 0;
    const jump = () => {
      raf = requestAnimationFrame(() => {
        const viewer = viewerRef.current;
        if (viewer == null) return;
        if (isFile) viewer.scrollTo({ type: 'item', id: itemId, align: 'start' });
        else viewer.scrollTo({ type: 'range', id: itemId, range });
      });
    };
    const stopOpening = revealClosedLines(itemId, ann, range, jump);
    if (!stopOpening) jump();
    return () => {
      stopOpening?.();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTargetAnnotation, filePathToItemId, previewItemIds]);

  const changeCursorRef = useRef<{ itemId: string; unifiedIndex: number } | null>(null);
  const jumpChange = useStableCallback((direction: 'next' | 'prev'): boolean => {
    const handle = viewerRef.current;
    const viewer = handle?.getInstance();
    if (handle == null || viewer == null) return false;
    const container = viewer.getContainerElement() ?? scrollRef.current;
    if (container == null) return false;
    const view = container.getBoundingClientRect();
    const scrolled = viewer.getScrollTop();
    const readingLine = readingLineFor(view, direction, {
      atTop: scrolled <= 1,
      atBottom: scrolled + viewer.getHeight() >= viewer.getScrollHeight() - 1,
    });

    const renderedElements = new Map<string, HTMLElement>();
    for (const rendered of viewer.getRenderedItems()) {
      if (rendered.type === 'diff' && rendered.element != null) renderedElements.set(rendered.id, rendered.element);
    }
    let firstRendered = Infinity;
    orderedItemIds.forEach((id, index) => {
      if (renderedElements.has(id) && index < firstRendered) firstRendered = index;
    });

    const spots: Array<{ itemId: string; change: DiffChange; placement: ChangePlacement; el: HTMLElement | null }> = [];
    orderedItemIds.forEach((itemId, index) => {
      const item = handle.getItem(itemId);
      if (item == null || item.type !== 'diff' || item.collapsed === true) return;
      const changes = listDiffChanges(item.fileDiff?.hunks);
      if (changes.length === 0) return;
      const element = renderedElements.get(itemId);
      let rows: { min: number; max: number } | null | undefined;
      for (const change of changes) {
        if (element == null) {
          spots.push({ itemId, change, placement: index < firstRendered ? 'before' : 'after', el: null });
          continue;
        }
        const el = findChangeElement(element, change);
        if (el != null) {
          spots.push({ itemId, change, placement: placementOf(el.getBoundingClientRect(), readingLine), el });
          continue;
        }
        if (rows === undefined) rows = renderedUnifiedRange(element);
        const placement: ChangePlacement = rows != null
          ? (change.unifiedIndex < rows.min ? 'before' : 'after')
          : (element.getBoundingClientRect().bottom <= readingLine ? 'before' : 'after');
        spots.push({ itemId, change, placement, el: null });
      }
    });
    if (spots.length === 0) return false;

    const cursor = changeCursorRef.current;
    let current: number | null = null;
    if (cursor != null) {
      const index = spots.findIndex(
        (spot) => spot.itemId === cursor.itemId && spot.change.unifiedIndex === cursor.unifiedIndex,
      );
      const rect = index === -1 ? null : spots[index].el?.getBoundingClientRect();
      if (rect && rect.bottom > view.top && rect.top < view.bottom) current = index;
    }
    const target = resolveChangeJump(spots.map((spot) => spot.placement), direction, current);
    if (target == null) return false;
    const spot = spots[target];
    changeCursorRef.current = { itemId: spot.itemId, unifiedIndex: spot.change.unifiedIndex };
    handle.scrollTo({
      type: 'line',
      id: spot.itemId,
      lineNumber: spot.change.lineNumber,
      side: spot.change.side,
      align: 'center',
    });
    return true;
  });

  useEffect(() => {
    if (!isActive || readOnly || commentOnly) return;
    const handler = (e: KeyboardEvent) => {
      // composedPath()[0] pierces shadow DOM: window-level e.target retargets to the shadow HOST
      // (e.g. <diffs-container>), which would hide a typeable element living inside a shadow root
      // from this guard.
      const el = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      )
        return;
      const changeDirection = changeJumpDirection(e);
      if (changeDirection) {
        if (jumpChange(changeDirection)) e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (orderedItemIds.length === 0) return;

      const currentId = visibleFileRef.current
        ? filePathToItemId.get(visibleFileRef.current) ?? null
        : null;
      const currentPath = currentId ? itemIdToFilePath.get(currentId) ?? null : null;

      if (e.key === 'x' && currentId) {
        e.preventDefault();
        toggleItemCollapsed(currentId);
        return;
      }

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

      if (e.key === 'c' && currentPath && onAddFileCommentForFile) {
        e.preventDefault();
        const btn = fileCommentButtonRefs.current.get(currentPath);
        if (btn?.isConnected) setFileCommentAnchor({ el: btn, filePath: currentPath });
        return;
      }

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
    commentOnly,
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
    jumpChange,
  ]);

  const editingFilePath = editSession.editingItemId != null
    ? itemIdToFilePath.get(editSession.editingItemId) ?? null
    : null;
  const onEditingFileChange = markdownPreview?.onEditingFileChange;
  useEffect(() => {
    onEditingFileChange?.(editingFilePath);
  }, [onEditingFileChange, editingFilePath]);
  useEffect(() => () => onEditingFileChange?.(null), [onEditingFileChange]);

  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const resolveViewTarget = useStableCallback((): string | null => {
    const viewer = viewerRef.current?.getInstance();
    const isPreviewable = markdownPreviewRef.current?.isPreviewable;
    if (viewer == null || !isPreviewable) return null;
    // Only files in the viewport count (rendered items include overscan), so
    // P never switches a file the person cannot see.
    const container = viewer.getContainerElement();
    const view = container?.getBoundingClientRect();
    const rendered = viewer.getRenderedItems().filter((item) => {
      if (!view) return true;
      const rect = item.element.getBoundingClientRect();
      return rect.bottom > view.top + 1 && rect.top < view.bottom - 1;
    });
    const markdownPathOf = (itemId: string): string | null => {
      const file = itemIdToFile.get(itemId);
      return file && isPreviewable(file) ? file.path : null;
    };
    const active = document.activeElement;
    if (active && active !== document.body) {
      const holder = rendered.find((item) => item.element.contains(active));
      if (holder) return markdownPathOf(holder.id);
    }
    const pointer = pointerRef.current;
    if (pointer) {
      const under = rendered.find((item) => {
        const rect = item.element.getBoundingClientRect();
        return pointer.y >= rect.top && pointer.y < rect.bottom;
      });
      if (under) return markdownPathOf(under.id);
    }
    for (const item of rendered) {
      const path = markdownPathOf(item.id);
      if (path) return path;
    }
    return null;
  });
  const registerViewTarget = markdownPreview?.registerViewTarget;
  useEffect(() => {
    if (!registerViewTarget) return;
    registerViewTarget(resolveViewTarget);
    return () => registerViewTarget(null);
  }, [registerViewTarget, resolveViewTarget]);

  const renderCustomHeader = useStableCallback((item: CodeViewItem<DiffAnnotationMetadata>) => {
    if (item.type !== 'diff') return null;
    const filePath = itemIdToFilePath.get(item.id);
    if (filePath == null) return null;
    const file = itemIdToFile.get(item.id);
    if (file == null) return null;

    const collapsed = item.collapsed === true;
    const previewControl = markdownPreview;
    const previewable = !!previewControl && previewControl.isPreviewable(file);
    const previewed = previewable && previewItemIdsRef.current.has(item.id);
    const allFileComments = fileCommentsByPath.get(filePath) ?? [];
    const fileComments = previewed ? allFileComments.filter((comment) => !comment.markdownPreview) : allFileComments;
    const isOversizedStub = isOversizedReviewStubPatch(file.patch);
    const isBinaryNotice = !isOversizedStub && isContentlessBinaryPatch(file.patch);
    const remeasure = () => refreshItem(item.id);
    const imagePreview = !collapsed && renderImagePreview && isImagePreviewCandidate(file.patch, file.path, file.oldPath)
      ? renderImagePreview({
          file,
          fallback: isOversizedStub
            ? <OversizedFileNotice onHeightChange={remeasure} />
            : isBinaryNotice ? <BinaryFileNotice onHeightChange={remeasure} /> : null,
          tooLargeFallback: isOversizedStub ? <OversizedFileNotice onHeightChange={remeasure} /> : undefined,
          onHeightChange: remeasure,
        })
      : null;
    const isEditingThis = editEnabled && editSession.editingItemIdRef.current === item.id;
    const editDisabledReason = editEnabled
      ? (previewed ? 'Switch to Source to edit this file' : editSession.editUnavailableRef.current.get(filePath) ?? null)
      : null;

    return (
      <div
        className="flex flex-col"
        ref={imagePreviewItemIdsRef.current.has(item.id) ? getHeaderMeasureRef(item.id) : undefined}
      >
        <FileHeader
        compactTouchLayout={compactTouchLayout}
        keepsFolder={headerKeepsFolder}
        readOnly={readOnly || commentOnly}
        openIn={fileOpenIn?.(filePath)}
        filePath={filePath}
        patch={file.patch}
        status={file.status}
        oldPath={file.oldPath}
        onEditFile={editEnabled ? () => editSession.startEdit(item.id) : undefined}
        isEditing={isEditingThis}
        editDisabledReason={editDisabledReason}
        isViewed={viewedFiles?.has(filePath)}
        isGenerated={generatedFiles?.has(filePath) === true}
        isTest={fileKind(filePath, generatedFiles) === 'test'}
        renderMarkdownView={previewable ? (fit) => previewControl!.renderViewControl({ file, ...fit }) : undefined}
        onToggleViewed={onToggleViewed ? () => handleToggleViewedAndCollapse(filePath, item.id) : undefined}
        showViewedControl={showViewedControls}
        viewedKeyHint={!readOnly && !commentOnly}
        isStaged={stagedFiles?.has(filePath)}
        isStaging={stagingFile === filePath}
        onStage={onStage ? () => onStage(filePath) : undefined}
        canStage={canStagePath ? canStagePath(filePath) : canStageFiles}
        showStageControl={showStageControls}
        stageError={stagingFile === filePath ? stageError : null}
        onFileComment={onAddFileCommentForFile ? (anchorEl) => handleFileComment(filePath, anchorEl) : undefined}
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
        {collapsed && generatedFiles?.has(filePath) === true && (
          <GeneratedFileNotice
            additions={file.additions}
            deletions={file.deletions}
            onExpand={() => toggleItemCollapsed(item.id)}
            onHeightChange={() => refreshItem(item.id)}
          />
        )}
        {imagePreview}
        {renderPackageChanges && (!collapsed || packageFileKind(filePath)?.role === 'lockfile') && packageFileKind(filePath)
          ? renderPackageChanges({ file, onHeightChange: remeasure })
          : null}
        {!collapsed && !imagePreview && isOversizedStub && (
          <OversizedFileNotice onHeightChange={() => refreshItem(item.id)} />
        )}
        {!collapsed && !imagePreview && isBinaryNotice && (
          <BinaryFileNotice onHeightChange={() => refreshItem(item.id)} />
        )}
        {isEditingThis && (
          <EditSessionHud
            onComplete={editSession.completeEdit}
            onCancel={editSession.cancelEdit}
            dirtyStore={editSession.dirtyStore}
          />
        )}
        {!collapsed && (hostFileNotesByPathRef.current.get(filePath) ?? []).map((note) => (
          <div key={note.id} data-host-file-note={note.id}>{note.render()}</div>
        ))}
        {!collapsed && fileComments.length > 0 && (
          <FileCommentBanner
            comments={fileComments}
            selectedAnnotationId={selectedAnnotationId}
            onSelect={onSelectAnnotation}
            onEdit={onEditAnnotation}
            onDelete={onDeleteAnnotation}
            onExplain={explainHandler}
            agentFindingSources={agentFindingSources}
            explainDisabled={isAILoading}
            onHeightChange={() => refreshItem(item.id)}
          />
        )}
        {!collapsed && previewed && previewControl!.render({ file, onHeightChange: remeasure })}
      </div>
    );
  });

  const customLineHeight = useMemo(() => {
    if (!fontSize) return undefined;
    const px = parseFloat(fontSize);
    return Number.isFinite(px) && px > 0 ? Math.round(px * 1.5) : undefined;
  }, [fontSize]);

  const hostHeaderExtra = useMemo(() => {
    if (hostFileNotes.length === 0 || files.length === 0) return 0;
    let shared: number | null = null;
    for (const file of files) {
      const notes = hostFileNotesByPath.get(file.path) ?? [];
      if (notes.some((note) => note.height === undefined)) return 0;
      const sum = notes.reduce((total, note) => total + note.height!, 0);
      if (shared !== null && sum !== shared) return 0;
      shared = sum;
    }
    return shared ?? 0;
  }, [hostFileNotes, hostFileNotesByPath, files]);
  const itemMetrics = useMemo<Partial<VirtualFileMetrics>>(
    () => ({
      diffHeaderHeight: (compactTouchLayout ? COMPACT_PANEL_HEADER_HEIGHT : PANEL_HEADER_HEIGHT) + hostHeaderExtra,
      ...(hunkSeparators === 'line-info' && { hunkSeparatorHeight: HUNK_SEPARATOR_HEIGHT }),
      spacing: 0,
      // Spacing 0 would count no room under the last row, but the code keeps Pierre's 8px there
      // (its padding plus its sideways scrollbar's gutter): counted, the bar is not cut off by the
      // box or drawn over the next file.
      paddingBottom: 8,
      ...(customLineHeight != null && { lineHeight: customLineHeight }),
    }),
    [compactTouchLayout, customLineHeight, hunkSeparators, hostHeaderExtra],
  );
  itemMetricsRef.current = itemMetrics;

  const options = useMemo<CodeViewOptions<DiffAnnotationMetadata>>(
    () => ({
      themeType: pierreTheme.type,
      unsafeCSS: scrollsWithPage ? `${pierreTheme.css}${SCROLLS_WITH_PAGE_CSS}${flushFiles ? FLUSH_FILES_CSS : STUCK_HEADER_LINE_CSS}` : pierreTheme.css,
      ...(pierreTheme.syntaxTheme && { theme: pierreTheme.syntaxTheme }),
      diffStyle,
      overflow: diffOverflow,
      diffIndicators,
      lineDiffType,
      disableLineNumbers,
      disableBackground,
      expandUnchanged,
      ...(opensWholeFiles && { loadDiffFiles: loadWholeFile }),
      // Pierre turns its rows' pointer events off for 120 ms after each scroll of its root.
      ...(scrollsWithPage && { pointerEventsOnScroll: true }),
      enableLineSelection: !readOnly,
      enableGutterUtility: !readOnly,
      hunkSeparators,
      stickyHeaders: true,
      // Keep Pierre's default 8px list edge padding. leadingHeight reserves space for the
      // leading-content portal (commit description card) so items start below it and it scrolls
      // with them.
      layout: scrollsWithPage ? { gap: 0, paddingTop: 0, paddingBottom: 0 } : { gap: 0, paddingTop: 8 + leadingHeight, paddingBottom: 8 },
      itemMetrics,
      // Pierre compares its virtualization estimates against measured DOM heights and warns on
      // drift.
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
      ...((onCodeNavRequest || onTokenHoverEnter || onTokenTarget) && {
        // Pierre's renderer-options builder drops onToken* before it evaluates
        // shouldUseTokenTransformer, so the handlers alone never wrap tokens (no data-char) and
        // token events never fire.
        useTokenTransformer: true,
        onTokenClick(props, event, context) {
          handleTokenClick(props, event, context.item);
        },
        onTokenEnter(props, event, context) {
          handleTokenEnter(props, event, context.item);
        },
        onTokenLeave(props, _event, _context) {
          handleTokenLeave(props);
        },
      }),
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
      hunkSeparators,
      opensWholeFiles,
      loadWholeFile,
      readOnly,
      itemMetrics,
      leadingHeight,
      scrollsWithPage,
      flushFiles,
      handleLineSelectionEnd,
      handleGutterUtilityClick,
      onCodeNavRequest,
      onTokenHoverEnter,
      onTokenTarget,
      handleTokenClick,
      handleTokenEnter,
      handleTokenLeave,
      handlePostRender,
    ],
  );

  const lastItemMetricsRef = useRef(itemMetrics);
  useEffect(() => {
    if (lastItemMetricsRef.current === itemMetrics) return;
    lastItemMetricsRef.current = itemMetrics;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        appliedHeaderMetricsRef.current = new WeakMap();
        for (const itemId of headerMetricsInstancesRef.current.keys()) syncHeaderMetrics(itemId);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [itemMetrics, syncHeaderMetrics]);

  if (!workerPoolReady) {
    return <div className="relative h-full" />;
  }

  const codeView = (
    <CodeView<DiffAnnotationMetadata>
      key={fileSetKey}
      ref={attachViewer}
      containerRef={attachScrollContainer}
      className={`relative ${scrollsWithPage ? 'overflow-x-clip [contain:layout_style]' : `h-full overflow-y-auto overflow-x-clip ${allowScrollChaining ? 'overscroll-auto' : 'overscroll-contain'} [contain:strict] [will-change:scroll-position]`} [overflow-anchor:none] focus-visible:outline-none! [&_diffs-container]:overflow-clip [&_diffs-container]:[contain:layout_paint_style]`}
      initialItems={identity.items}
      options={options}
      selectedLines={selectedLines}
      onSelectedLinesChange={handleSelectedLinesChange}
      onScroll={handleScroll}
      renderCustomHeader={renderCustomHeader}
      renderAnnotation={renderAnnotation}
      {...(editEnabled && {
        editorOptions: editSession.editorOptions,
        onItemEditChange: editSession.onItemEditChange,
        onItemEditComplete: editSession.onItemEditComplete,
      })}
    />
  );

  return (
    <div
      className="relative h-full"
      style={flushesFiles && trailingUnread ? { marginBottom: -HUNK_SEPARATOR_HEIGHT } : undefined}
      data-history-owner={editSession.editingItemId ? 'edit-session' : undefined}
      onPointerMove={markdownPreview ? (event) => { pointerRef.current = { x: event.clientX, y: event.clientY }; } : undefined}
      onPointerLeave={markdownPreview ? () => { pointerRef.current = null; } : undefined}
    >
      {editEnabled ? (
        <EditProvider createEditor={editSession.createEditor}>{codeView}</EditProvider>
      ) : (
        codeView
      )}
      {diffOverflow !== 'wrap' && <DiffBottomBar root={scrollEl} />}

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
        askOnly={askOnly && !!aiAvailable}
        selectionActions={selectionActions}
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
            editSession.collapseSelection();
            setSelectionAnnotationRequest(null);
          }}
          onClose={() => setSelectionAnnotationRequest(null)}
        />
      )}
    </div>
  );
};
