import React, { useMemo, useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import { FileDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import { getSingularPatch, processFile } from '@pierre/diffs';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, DiffAnnotationMetadata, TokenAnnotationMeta, ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import type { DiffTokenEventBaseProps } from '@pierre/diffs';
import { usePierreTheme } from '../hooks/usePierreTheme';
import { useFileContents } from '../hooks/useFileContents';
import { useWorkerPoolThemeSync } from '../workerPool';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { storage } from '@plannotator/ui/utils/storage';
import { detectLanguage } from '../utils/detectLanguage';
import { buildCodeNavRequest } from '../utils/buildCodeNavRequest';
import { ToolbarHost, type ToolbarHostHandle } from './ToolbarHost';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { useOverlayViewport } from '@plannotator/ui/hooks/useOverlayViewport';
import { FileHeader } from './FileHeader';
// Lazy: the rendered views bring the text highlighter (which needs a DOM at
// import), so it loads the first time a file is shown as Changes or Read.
// (The single-file build inlines the chunk; no diagram engine is in it:
// diagram fences render as code.)
const MarkdownFilePreview = React.lazy(async () => ({ default: (await import('./MarkdownFilePreview')).MarkdownFilePreview }));
import { fileViewOfRendered, renderedViewOf, type MarkdownPreviewView } from '../hooks/useMarkdownPreview';
import { MarkdownViewMenu } from './MarkdownViewMenu';
import { BinaryFileNotice } from './BinaryFileNotice';
import { FileCommentBanner } from './FileCommentBanner';
import { DiffHScrollbar } from './DiffHScrollbar';
import { OversizedFileNotice } from './OversizedFileNotice';
import { isContentlessBinaryPatch, isImagePreviewCandidate, isOversizedReviewStubPatch } from '@plannotator/shared/diff-paths';
import { ImageDiffPreview } from './ImageDiffPreview';
import { PackageChangesCard } from './PackageChangesCard';
import { isPackageChangePath } from '@plannotator/core/package-changes';
import { isFileScopedAnnotation, lineRangeForAnnotation } from '../utils/annotationScope';
import { lineAnnotationMetadata } from '../utils/annotationDisplay';
import type { AnnotationScrollTarget } from '../types';
import { getLineNumberFromNode, getSideFromNode, getDiffSelection, snapshotDiffSelection, rangeForGutterClick, type DiffSelectionSnapshot } from '../utils/diffSelection';
import { isContentConsistentWithPatch } from '../utils/patchConsistency';
import { hashString } from '../utils/hashString';
import { markdownPreviewSourcePath, markdownViewsFor, resolveMarkdownView, type MarkdownFileView } from '../utils/markdownPreview';
import { InlineAnnotation } from './InlineAnnotation';
import { InlineAIMarker } from './InlineAIMarker';
import type { AIChatEntry } from '../hooks/useAIChat';
import { type ReviewSearchMatch } from '../utils/reviewSearch';
import {
  applySearchHighlights,
  clearSearchHighlights,
  getSearchRoots,
  retryScrollToSearchMatch,
  swapActiveSearchHighlight,
} from '../utils/reviewSearchHighlight';
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
  resolveChangeJump,
  type ChangePlacement,
} from '../utils/changeNavigation';

interface PierreDiffContentProps {
  filePath: string;
  fileDiff: ReturnType<typeof getSingularPatch>;
  pierreTheme: { type: 'dark' | 'light'; css: string; syntaxTheme?: { dark: string; light: string } };
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  expandUnchanged?: boolean;
  mergedAnnotations: DiffLineAnnotation<DiffAnnotationMetadata>[];
  pendingSelection: SelectedLineRange | null;
  onLineSelectionEnd: (range: SelectedLineRange | null) => void;
  /** In-flight selection deltas. Only wired when Pierre needs the host to
   *  repaint (see the options block below); undefined leaves the option off
   *  the object entirely. */
  onLineSelectionChange?: (range: SelectedLineRange | null) => void;
  onGutterUtilityClick: (range: SelectedLineRange) => void;
  renderAnnotation: (annotation: { side: string; lineNumber: number; metadata?: DiffAnnotationMetadata }) => React.ReactNode;
  onTokenClick?: (props: DiffTokenEventBaseProps, event: MouseEvent) => void;
  onTokenEnter?: (props: DiffTokenEventBaseProps, event: PointerEvent) => void;
  onTokenLeave?: (props: DiffTokenEventBaseProps, event: PointerEvent) => void;
}

const PierreDiffContent = React.memo(({
  filePath,
  fileDiff,
  pierreTheme,
  diffStyle,
  diffOverflow,
  diffIndicators,
  lineDiffType,
  disableLineNumbers,
  disableBackground,
  expandUnchanged,
  mergedAnnotations,
  pendingSelection,
  onLineSelectionEnd,
  onLineSelectionChange,
  onGutterUtilityClick,
  renderAnnotation,
  onTokenClick,
  onTokenEnter,
  onTokenLeave,
}: PierreDiffContentProps) => {
  return (
    <FileDiff
      key={filePath}
      fileDiff={fileDiff}
      options={{
        themeType: pierreTheme.type,
        unsafeCSS: pierreTheme.css,
        ...(pierreTheme.syntaxTheme && { theme: pierreTheme.syntaxTheme }),
        // We render our own FileHeader above this view; suppress Pierre's
        // built-in header (and its file-status symbol) so it doesn't double up.
        disableFileHeader: true,
        diffStyle,
        overflow: diffOverflow,
        diffIndicators,
        lineDiffType,
        disableLineNumbers,
        disableBackground,
        expandUnchanged,
        hunkSeparators: 'line-info',
        enableLineSelection: true,
        enableGutterUtility: true,
        onGutterUtilityClick,
        onLineSelectionEnd,
        // A defined `selectedLines` prop puts Pierre in controlled-selection
        // mode, where `InteractionManager.updateSelection` only stores a
        // proposed range and leaves the painted highlight to whatever the host
        // hands back. Without a change handler a second drag therefore never
        // repaints. Spread conditionally so surfaces that don't need it keep an
        // options object with no such key at all.
        ...(onLineSelectionChange ? { onLineSelectionChange } : {}),
        // Pierre's renderer-options builder drops onToken* before it evaluates
        // shouldUseTokenTransformer, so passing the handlers alone never wraps
        // tokens (no data-char) and code-nav/token events never fire. Enable
        // the token transformer explicitly.
        useTokenTransformer: true,
        onTokenClick,
        onTokenEnter,
        onTokenLeave,
      }}
      lineAnnotations={mergedAnnotations}
      selectedLines={pendingSelection || undefined}
      renderAnnotation={renderAnnotation}
    />
  );
}, (prev, next) => (
  prev.filePath === next.filePath &&
  prev.fileDiff === next.fileDiff &&
  prev.pierreTheme.type === next.pierreTheme.type &&
  prev.pierreTheme.css === next.pierreTheme.css &&
  prev.pierreTheme.syntaxTheme?.dark === next.pierreTheme.syntaxTheme?.dark &&
  prev.pierreTheme.syntaxTheme?.light === next.pierreTheme.syntaxTheme?.light &&
  prev.diffStyle === next.diffStyle &&
  prev.diffOverflow === next.diffOverflow &&
  prev.diffIndicators === next.diffIndicators &&
  prev.lineDiffType === next.lineDiffType &&
  prev.disableLineNumbers === next.disableLineNumbers &&
  prev.disableBackground === next.disableBackground &&
  prev.expandUnchanged === next.expandUnchanged &&
  prev.mergedAnnotations === next.mergedAnnotations &&
  prev.pendingSelection === next.pendingSelection &&
  prev.onLineSelectionEnd === next.onLineSelectionEnd &&
  prev.onLineSelectionChange === next.onLineSelectionChange &&
  prev.onGutterUtilityClick === next.onGutterUtilityClick &&
  prev.renderAnnotation === next.renderAnnotation &&
  prev.onTokenClick === next.onTokenClick &&
  prev.onTokenEnter === next.onTokenEnter &&
  prev.onTokenLeave === next.onTokenLeave
));

interface DiffViewerProps {
  patch: string;
  filePath: string;
  oldPath?: string;
  /** Change type for the header icon + rename display. */
  status?: import('../types').DiffFileStatus;
  /** Base branch override used for file-content lookups (branch / merge-base modes only). */
  reviewBase?: string;
  /** False when there is no source behind the diff to expand into (static
   *  patch review): skip the /api/file-content fetch entirely rather than
   *  firing a request the server answers 400. Absent means available. */
  contextExpansionAvailable?: boolean;
  /** Opaque diff snapshot used to reject mutable file-content lookups from another view. */
  reviewSnapshotId?: string;
  /** Server advertised `imagePreviewSupported`: a hunkless image chunk renders
   *  as a Before/After preview instead of the binary notice. Absent = off. */
  imagePreviewAvailable?: boolean;
  /** Snapshot the image preview binds its requests to (set in PR mode too,
   *  where `reviewSnapshotId` is not). Falls back to `reviewSnapshotId`. */
  imageSnapshotId?: string;
  /** A package.json or lockfile diff shows its package changes under the
   *  header. Absent (read-only hosts): nothing is fetched or drawn. */
  packageChangesAvailable?: boolean;
  /** Current PR url + diff scope — used to namespace file-comment drafts so they don't leak across in-place PR switches. */
  prUrl?: string;
  prDiffScope?: string;
  isFocused?: boolean;
  /** `N` / `Shift+N` step through this file's changes (#1543). On only for the
   *  focused file of the active single-file panel, so one key never moves two
   *  diffs. */
  changeNavigation?: boolean;
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  expandUnchanged?: boolean;
  fontFamily?: string;
  fontSize?: string;
  annotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  scrollTargetAnnotation: AnnotationScrollTarget | null;
  pendingSelection: SelectedLineRange | null;
  /** Compact coarse-pointer shell. Keeps range selection separate from writing. */
  compactTouchLayout?: boolean;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel, decorations?: ConventionalDecoration[], tokenMeta?: TokenAnnotationMeta) => void;
  onAddFileComment: (text: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel | null, decorations?: ConventionalDecoration[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
  isViewed?: boolean;
  onToggleViewed?: () => void;
  /** Chrome preference (#1277): false hides the header Viewed button; the `V`
   *  shortcut and viewed state are unaffected. */
  showViewedControls?: boolean;
  /** Marked `linguist-generated` in `.gitattributes` (#1317) — shows the
   * header "generated" tag. The single-file surface never collapses for it:
   * opening a file as its own tab is already an explicit request to see it. */
  isGenerated?: boolean;
  /** A test file: a flask after the name in the header. */
  isTest?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  isStaged?: boolean;
  isStaging?: boolean;
  onStage?: () => void;
  canStage?: boolean;
  /** Same preference for the header Git Add button (`A` shortcut still works). */
  showStageControls?: boolean;
  stageError?: string | null;
  searchQuery?: string;
  searchMatches?: ReviewSearchMatch[];
  activeSearchMatchId?: string | null;
  activeSearchMatch?: ReviewSearchMatch | null;
  // AI props
  aiAvailable?: boolean;
  onAskAI?: (question: string) => void;
  isAILoading?: boolean;
  onViewAIResponse?: (questionId?: string) => void;
  aiMessages?: AIChatEntry[];
  onClickAIMarker?: (questionId: string) => void;
  /** AI messages overlapping the current pending selection */
  aiHistoryMessages?: AIChatEntry[];
  // Code navigation
  onCodeNavRequest?: (request: import('@plannotator/shared/code-nav').CodeNavRequest) => void;
  /**
   * Token hover cards. Absent (the default) means the feature is not wired at
   * all. Deliberately raw: the view reports the token event and its file, and
   * the caller decides what a hoverable symbol is. Stitching a fragmented
   * identifier is app-only work, and this component is also compiled into the
   * read-only portable guide viewer, which passes neither handler.
   */
  onTokenHoverEnter?: (props: DiffTokenEventBaseProps, filePath: string) => void;
  onTokenHoverLeave?: () => void;
  /** Every file path in this review. A link in the Markdown preview to one of
   *  them opens it; any other local link renders inert. */
  reviewFilePaths?: ReadonlySet<string>;
  /** Open another file of this review (a link in the Markdown preview). */
  onOpenReviewFile?: (filePath: string) => void;
  /**
   * A Markdown file's view (Source / Changes / Read) when the host owns it
   * (review state: per-file choices and the remembered starting view).
   * `how` says whether the person picked it (the header menu) or navigation
   * needed it (a search hit, a comment that lives in another view). Absent:
   * the viewer keeps its own view. `markdownPreviewSupported: false` hides
   * the control.
   */
  markdownView?: MarkdownFileView;
  onMarkdownViewChange?: (view: MarkdownFileView, how: 'chosen' | 'shown') => void;
  markdownPreviewSupported?: boolean;
  /** Set while the file's view cannot change (All files holds it in an edit session). */
  markdownViewDisabledReason?: string | null;
}

/** Shown while the preview's code loads (it is split from the diff view). */
const MarkdownPreviewPending: React.FC = () => (
  <div className="min-h-full px-4 py-4 sm:px-6" data-markdown-preview="" data-markdown-preview-view="pending">
    <div role="status" data-markdown-preview-state="loading" className="mx-auto max-w-3xl rounded-md border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
      Loading the full Markdown file…
    </div>
  </div>
);

export const DiffViewer: React.FC<DiffViewerProps> = ({
  patch,
  filePath,
  oldPath,
  status,
  reviewBase,
  reviewSnapshotId,
  imagePreviewAvailable = false,
  packageChangesAvailable = false,
  imageSnapshotId,
  contextExpansionAvailable = true,
  prUrl,
  prDiffScope,
  isFocused = false,
  changeNavigation = false,
  diffStyle,
  diffOverflow,
  diffIndicators = 'bars',
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
  compactTouchLayout = false,
  onLineSelection,
  onAddAnnotation,
  onAddFileComment,
  onEditAnnotation,
  onSelectAnnotation,
  onDeleteAnnotation,
  isViewed = false,
  onToggleViewed,
  showViewedControls = true,
  isGenerated = false,
  isTest = false,
  collapsed = false,
  onToggleCollapsed,
  isStaged = false,
  isStaging = false,
  onStage,
  canStage = false,
  showStageControls = true,
  stageError,
  searchQuery = '',
  searchMatches = [],
  activeSearchMatchId = null,
  activeSearchMatch = null,
  aiAvailable = false,
  onAskAI,
  isAILoading = false,
  onViewAIResponse,
  aiMessages = [],
  onClickAIMarker,
  aiHistoryMessages = [],
  onCodeNavRequest,
  onTokenHoverEnter,
  onTokenHoverLeave,
  reviewFilePaths,
  onOpenReviewFile,
  markdownView: markdownViewProp,
  onMarkdownViewChange,
  markdownPreviewSupported = true,
  markdownViewDisabledReason = null,
}) => {
  const pierreTheme = usePierreTheme({ fontFamily, fontSize, compactTouchLayout });
  // Worker-pool highlighting: keep the pool's theme pair in step with the UI
  // theme. (No mount gating here — the single-file panel renders one diff;
  // a main-thread fallback frame at startup is invisible.)
  useWorkerPoolThemeSync(pierreTheme.syntaxTheme);
  // containerRef must point at the actual scrolling element (the
  // OverlayScrollbars viewport), not the OverlayScrollArea host. `viewport`
  // is state so effects re-run once the library has mounted the viewport.
  const { ref: containerRef, viewport, onViewportReady } =
    useOverlayViewport<HTMLDivElement>();
  const splitSurfaceRef = useRef<HTMLDivElement>(null);
  const diffContentRef = useRef<HTMLDivElement>(null);
  const selectionSnapshotRef = useRef<DiffSelectionSnapshot | null>(null);
  const [fileCommentAnchor, setFileCommentAnchor] = useState<HTMLElement | null>(null);

  // Resizable split pane — only applies when Pierre renders a two-column grid
  // (files with both additions and deletions). Add-only or delete-only files
  // render as a single column even in split mode.
  const isSplitLayout = useMemo(() => {
    if (diffStyle !== 'split') return false;
    let hasAdd = false, hasDel = false;
    for (const line of patch.split('\n')) {
      if (line[0] === '+' && !line.startsWith('+++')) hasAdd = true;
      else if (line[0] === '-' && !line.startsWith('---')) hasDel = true;
      if (hasAdd && hasDel) return true;
    }
    return false;
  }, [patch, diffStyle]);

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
    if (!splitSurfaceRef.current) return;
    setIsDraggingSplit(true);

    const onMove = (moveEvent: PointerEvent) => {
      const rect = splitSurfaceRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
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

  const toolbarHostRef = useRef<ToolbarHostHandle>(null);

  // Parse patch into FileDiffMetadata for @pierre/diffs FileDiff component.
  //
  // Pinned to @pierre/diffs 1.3.2: `FileDiff.render` DEFAULTS an unset
  // `fileDiff.cacheKey` to the file's NAME (`prevName:name` for renames), and
  // `areDiffTargetsEqual` — the only identity check its render/highlight
  // caches make — compares nothing but that key. Two different diffs of the
  // same path therefore look IDENTICAL to Pierre, and the second one is
  // silently served the first one's cached render.
  //
  // This FileDiff instance survives (`key={filePath}`) across both the
  // partial -> full-content swap below AND diff-type / base / whitespace
  // switches, so every diff object handed to it must mint its own
  // content-derived key. Hash, not `patch.length`: the worker highlight cache
  // is a singleton that outlives remounts, so a same-length different-content
  // patch must not collide either. See AllFilesCodeView, which mints the same
  // shape of key for the all-files surface (which is why that surface was
  // never affected by this bug).
  const fileDiff = useMemo(() => {
    const parsed = getSingularPatch(patch);
    parsed.cacheKey = `${filePath}#${hashString(patch)}`;
    return parsed;
  }, [patch, filePath]);

  // Fetch full file contents for expandable context (and the Markdown preview)
  const fileContentsResult = useFileContents({
    filePath,
    oldPath,
    reviewBase,
    reviewSnapshotId,
    enabled: contextExpansionAvailable,
  });
  const { fileContents } = fileContentsResult;
  // The document the preview shows: the new file, or the old one for a
  // deletion. Null when that path is not Markdown (incl. a rename away from
  // Markdown), so no preview is offered.
  const markdownSourcePath = markdownPreviewSourcePath(filePath, oldPath, status);
  // A static patch has no full file behind it, so the preview could never
  // show anything: no toggle at all.
  const canPreviewMarkdown = markdownPreviewSupported && contextExpansionAvailable && markdownSourcePath !== null;
  const markdownViews = useMemo(() => markdownViewsFor({ status, patch }), [status, patch]);
  const [localMarkdownView, setLocalMarkdownView] = useState<{ path: string; view: MarkdownFileView } | null>(null);
  const viewControlled = markdownViewProp !== undefined;
  const markdownView: MarkdownFileView = canPreviewMarkdown
    ? resolveMarkdownView(
      viewControlled
        ? markdownViewProp
        : localMarkdownView?.path === filePath ? localMarkdownView.view : 'source',
      markdownViews,
    )
    : 'source';
  const markdownPreviewEnabled = markdownView !== 'source';
  const setMarkdownView = useCallback((view: MarkdownFileView, how: 'chosen' | 'shown') => {
    if (viewControlled) onMarkdownViewChange?.(view, how);
    else setLocalMarkdownView({ path: filePath, view });
  }, [viewControlled, onMarkdownViewChange, filePath]);
  const setMarkdownPreview = useCallback((on: boolean, rendered: MarkdownPreviewView = 'diff') => {
    setMarkdownView(on ? fileViewOfRendered(rendered) : 'source', 'shown');
  }, [setMarkdownView]);

  // Re-parse the patch with full file contents so hunk indices are computed
  // against the complete file (isPartial: false), enabling expansion.
  const augmentedDiff = useMemo(() => {
    if (!fileContents || fileContents.forPath !== filePath || (fileContents.old == null && fileContents.new == null)) return fileDiff;
    // Stale-content guard (same as AllFilesCodeView): the file may have
    // changed on disk since the diff was captured — augmenting with contents
    // that don't reconcile with the patch breaks Pierre's line math. Fall back
    // to the raw patch for this file.
    if (!isContentConsistentWithPatch(patch, fileContents.old, fileContents.new)) {
      console.warn(
        `DiffViewer: skipping full-content expansion for ${filePath} — file changed since the diff was captured`,
      );
      return fileDiff;
    }
    try {
      const result = processFile(patch, {
        oldFile: fileContents.old != null ? { name: oldPath || filePath, contents: fileContents.old } : undefined,
        newFile: fileContents.new != null ? { name: filePath, contents: fileContents.new } : undefined,
      });
      if (!result || result.isPartial) return fileDiff;
      // A DIFFERENT key from the partial diff above (`#full`), still derived
      // from the patch content so it also changes across diff-type / base
      // switches. Without it Pierre keeps painting the partial render forever:
      // gap bars with no chevrons and dead expansion clicks, at every file
      // size. (See the cacheKey note on `fileDiff`.)
      result.cacheKey = `${filePath}#full#${hashString(patch)}`;
      return result;
    } catch {
      return fileDiff;
    }
  }, [patch, filePath, oldPath, fileContents, fileDiff]);

  const chooseMarkdownView = useCallback((view: MarkdownFileView) => {
    // The line selection and its composer live in the diff a rendered view
    // replaces; drop them rather than leave a selection nothing shows.
    if (view !== 'source' && !markdownPreviewEnabled) onLineSelection(null);
    setMarkdownView(view, 'chosen');
  }, [markdownPreviewEnabled, onLineSelection, setMarkdownView]);

  // Turned on from elsewhere (`P`, another file's choice it follows): the
  // line selection lives in the diff the preview replaces.
  const wasPreviewEnabledRef = useRef(markdownPreviewEnabled);
  useEffect(() => {
    if (markdownPreviewEnabled && !wasPreviewEnabledRef.current && pendingSelection && isFocused) onLineSelection(null);
    wasPreviewEnabledRef.current = markdownPreviewEnabled;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdownPreviewEnabled]);

  // Navigation that targets diff lines (a search hit, a semantic-diff / AI
  // "scroll to lines", a requested line selection) switches the file back to
  // the diff first; the effects below then run against the mounted diff.
  // Only a CHANGE counts, so turning the preview on while a selection or
  // match is already active does not bounce straight back.
  const prevPendingSelectionRef = useRef(pendingSelection);
  const prevActiveSearchMatchIdRef = useRef(activeSearchMatch?.id ?? null);
  useEffect(() => {
    const activeSearchMatchId = activeSearchMatch?.id ?? null;
    const selectionChanged = pendingSelection !== prevPendingSelectionRef.current;
    const searchChanged = activeSearchMatchId !== prevActiveSearchMatchIdRef.current;
    prevPendingSelectionRef.current = pendingSelection;
    prevActiveSearchMatchIdRef.current = activeSearchMatchId;
    if (!markdownPreviewEnabled) return;
    if ((selectionChanged && pendingSelection && isFocused) || (searchChanged && activeSearchMatchId)) {
      setMarkdownPreview(false);
    }
  }, [pendingSelection, activeSearchMatch, markdownPreviewEnabled, isFocused, setMarkdownPreview]);

  const previousScrollFilePathRef = useRef(filePath);
  useLayoutEffect(() => {
    if (previousScrollFilePathRef.current === filePath) return;
    // A new file should start from the top-left of the diff viewport.
    // Only advance the tracking ref once the scroll actually executed —
    // otherwise a file switch landing before the OverlayScrollbars viewport
    // has attached would leave the viewport stale on old content.
    if (!containerRef.current) return;
    containerRef.current.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    previousScrollFilePathRef.current = filePath;
  }, [filePath, viewport]);

  // Clear pending selection when file changes
  const prevFilePathRef = useRef(filePath);
  useEffect(() => {
    if (prevFilePathRef.current !== filePath) {
      prevFilePathRef.current = filePath;
      onLineSelection(null);
    }
  }, [filePath, onLineSelection]);

  // Safari scroll-position guardian. Safari has a compositor bug where
  // scrollTop resets to 0 (sometimes multiple times in quick succession)
  // when momentum-scrolling ends inside a container whose child is a
  // web-component shadow DOM (@pierre/diffs `<diffs-container>`). The reset
  // bypasses JavaScript entirely — no scrollTo / scrollTop setter fires.
  // Detect the bogus resets and restore the last known good position.
  // Only active in WebKit — Chrome / Firefox / Edge are unaffected.
  //
  // filePath is in the dep array so the guardian resets when the user
  // switches files (the file-switch useLayoutEffect legitimately scrolls
  // to 0 — without resetting here the guardian would fight it).
  useEffect(() => {
    if (!viewport) return;
    const ua = navigator.userAgent;
    const isWebKit = ua.includes('Safari') && !ua.includes('Chrome');
    if (!isWebKit) return;

    let lastGoodST = 0;

    const onScroll = () => {
      const st = viewport.scrollTop;
      if (st > 0) {
        lastGoodST = st;
      } else if (lastGoodST > 200) {
        // scrollTop jumped from a distant position to 0 — Safari compositor bug.
        // A legitimate scroll-to-top always has intermediate events that bring
        // lastGoodST down to a small value before reaching 0. A jump from >200
        // to 0 in a single event can only be the bug. Restore synchronously so
        // the browser never paints the wrong frame.
        viewport.scrollTop = lastGoodST;
      } else {
        // Near the top already (lastGoodST ≤ 200) — legitimate scroll to top
        lastGoodST = 0;
      }
    };

    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [viewport, filePath]);

  // Scroll to a comment ONLY on sidebar navigation (scrollTargetAnnotation),
  // never on a bare in-diff selection — clicking a comment must not move the
  // viewport. Keyed on the token so re-clicking the same sidebar row re-centers.
  // A line comment in a file shown as a Markdown preview switches back to the
  // diff first (this effect runs again once it is mounted); a file comment
  // shows above the preview too, so it scrolls in place.
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const handledScrollTargetRef = useRef<AnnotationScrollTarget | null>(null);
  useEffect(() => {
    if (!scrollTargetAnnotation || !containerRef.current) return;
    if (handledScrollTargetRef.current === scrollTargetAnnotation) return;
    const targetId = scrollTargetAnnotation.id;

    const target = annotationsRef.current.find((ann) => ann.id === targetId);
    if (target?.markdownPreview) {
      // A comment made in the preview lives there: show the preview, whose
      // highlighter scrolls to the selected comment.
      if (!markdownPreviewEnabled && canPreviewMarkdown) {
        setMarkdownPreview(true, target.markdownPreview.view);
        return;
      }
      if (markdownPreviewEnabled) {
        handledScrollTargetRef.current = scrollTargetAnnotation;
        return;
      }
    }
    if (markdownPreviewEnabled) {
      if (!target) return; // another file's comment
      if (!isFileScopedAnnotation(target)) {
        setMarkdownPreview(false);
        return;
      }
    }
    handledScrollTargetRef.current = scrollTargetAnnotation;

    // The diff may still be rendering (just switched back from the preview):
    // retry for a moment before giving up.
    let attempts = 0;
    let timeoutId: ReturnType<typeof setTimeout>;
    const tryScroll = () => {
      const annotationEl = containerRef.current?.querySelector(
        `[data-annotation-id="${targetId}"]`
      );
      if (annotationEl) {
        annotationEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      attempts += 1;
      if (attempts < 20) timeoutId = setTimeout(tryScroll, 100);
    };
    timeoutId = setTimeout(tryScroll, 100);

    return () => clearTimeout(timeoutId);
  }, [scrollTargetAnnotation, viewport, markdownPreviewEnabled]);

  // Apply search highlights to diff lines (including inside shadow DOM).
  // The query is already debounced upstream (useReviewSearch), so this runs synchronously.
  // activeSearchMatchId is NOT in deps — the swap effect handles that with O(1) updates.
  useEffect(() => {
    if (!containerRef.current || markdownPreviewEnabled) return;

    const query = searchQuery;
    const matches = searchMatches;

    if (!query.trim() || matches.length === 0) {
      const roots = getSearchRoots(containerRef.current);
      roots.forEach(root => clearSearchHighlights(root));
      return;
    }

    const roots = getSearchRoots(containerRef.current);
    roots.forEach(root =>
      applySearchHighlights(root, query, matches, activeSearchMatchId)
    );
  }, [searchQuery, searchMatches, filePath, diffStyle, diffOverflow, diffIndicators, lineDiffType, disableLineNumbers, disableBackground, expandUnchanged, augmentedDiff, viewport, markdownPreviewEnabled]);

  // Swap active search highlight instantly when stepping between matches.
  // This avoids a full rebuild just to change two elements' background color.
  useEffect(() => {
    if (!containerRef.current || markdownPreviewEnabled) return;
    swapActiveSearchHighlight(containerRef.current, activeSearchMatchId);
  }, [activeSearchMatchId, viewport, markdownPreviewEnabled]);

  // Scroll to active search match (with retry for lazy-rendered content)
  useEffect(() => {
    if (!activeSearchMatch || !containerRef.current || markdownPreviewEnabled) return;
    return retryScrollToSearchMatch(containerRef.current, activeSearchMatch);
  }, [activeSearchMatch, filePath, diffStyle, diffOverflow, diffIndicators, lineDiffType, disableLineNumbers, disableBackground, expandUnchanged, viewport, markdownPreviewEnabled]);

  // Scroll to the selected line range — drives "jump to entity" from semantic-diff
  // clicks and AI "scroll to lines". Mirrors the scroll-to-annotation behavior used
  // by sidebar comments (center the target, smooth). pierre tags the selected rows
  // with `[data-selected-line]` inside the diff shadow DOM once it applies
  // `selectedLines`, so we retry across frames until it appears.
  //
  // Only scroll when the target is off-screen: a manual drag-select also sets
  // pendingSelection, but its lines are by definition already visible, so we leave
  // the view untouched and avoid yanking it on every selection.
  useEffect(() => {
    if (!pendingSelection || !containerRef.current || markdownPreviewEnabled) return;
    const container = containerRef.current;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 30;

    const tryScroll = () => {
      if (cancelled) return;
      const target = getSearchRoots(container)
        .map((root) => (root as ParentNode).querySelector?.('[data-selected-line]') ?? null)
        .find((el): el is Element => el != null);
      if (target) {
        const targetRect = target.getBoundingClientRect();
        const viewRect = container.getBoundingClientRect();
        const fullyVisible = targetRect.top >= viewRect.top && targetRect.bottom <= viewRect.bottom;
        if (!fullyVisible) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }
        return;
      }
      attempts += 1;
      if (attempts < MAX_ATTEMPTS) requestAnimationFrame(tryScroll);
    };

    const raf = requestAnimationFrame(tryScroll);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [pendingSelection, filePath, augmentedDiff, viewport, markdownPreviewEnabled]);

  // Map annotations to @pierre/diffs format
  const lineAnnotations = useMemo(() => {
    return annotations
      .filter(ann => (ann.scope ?? 'line') === 'line')
      .map(ann => ({
        side: ann.side === 'new' ? 'additions' as const : 'deletions' as const,
        lineNumber: ann.lineEnd,
        metadata: lineAnnotationMetadata(ann),
      }));
  }, [annotations]);

  // Derive AI markers for the current file's lines
  const aiLineAnnotations = useMemo(() => {
    if (!aiMessages.length) return [];
    return aiMessages
      .filter(m => m.question.lineStart != null && m.question.lineEnd != null)
      .map(({ question, response }) => ({
        side: question.side === 'new' ? 'additions' as const : 'deletions' as const,
        lineNumber: question.lineEnd!,
        metadata: {
          annotationId: question.id,
          type: 'comment' as CodeAnnotationType,
          kind: 'ai-marker' as const,
          questionId: question.id,
          promptPreview: question.prompt.slice(0, 40) + (question.prompt.length > 40 ? '...' : ''),
          hasResponse: !!response.text && !response.error,
          isStreaming: response.isStreaming,
        } as DiffAnnotationMetadata,
      }));
  }, [aiMessages]);

  const mergedAnnotations = useMemo(
    () => [...lineAnnotations, ...aiLineAnnotations],
    [lineAnnotations, aiLineAnnotations],
  );

  // Handle edit: find annotation and start editing in toolbar
  const handleEdit = useCallback((id: string) => {
    const ann = annotations.find(a => a.id === id);
    if (ann) toolbarHostRef.current?.startEdit(ann);
  }, [annotations]);

  // Render annotation or AI marker in diff
  const renderAnnotation = useCallback((annotation: { side: string; lineNumber: number; metadata?: DiffAnnotationMetadata }) => {
    if (!annotation.metadata) return null;

    if (annotation.metadata.kind === 'ai-marker') {
      return (
        <InlineAIMarker
          questionId={annotation.metadata.questionId!}
          promptPreview={annotation.metadata.promptPreview!}
          hasResponse={annotation.metadata.hasResponse!}
          isStreaming={annotation.metadata.isStreaming!}
          onClick={onClickAIMarker ?? (() => {})}
        />
      );
    }

    return (
      <InlineAnnotation
        metadata={annotation.metadata}
        language={detectLanguage(filePath)}
        isSelected={annotation.metadata.annotationId === selectedAnnotationId}
        onSelect={onSelectAnnotation}
        onEdit={handleEdit}
        onDelete={onDeleteAnnotation}
      />
    );
  }, [filePath, selectedAnnotationId, onSelectAnnotation, handleEdit, onDeleteAnnotation, onClickAIMarker]);

  const handleLineSelectionInteraction = useCallback((
    source: LineSelectionSource,
    range: SelectedLineRange | null,
  ) => {
    // A cleared selection is never something to preserve. AllFilesCodeView
    // early-returns on a null range; single-file has to route it to the toolbar
    // host so an open composer (including the Ask AI window) closes with it —
    // that call also publishes the null selection upwards.
    if (range == null) {
      toolbarHostRef.current?.handleLineSelectionEnd(null);
      return;
    }
    if (resolveLineSelectionBehavior({ source, compactTouchLayout }) === 'preserve-selection') {
      onLineSelection(range);
      return;
    }
    toolbarHostRef.current?.handleLineSelectionEnd(range);
  }, [compactTouchLayout, onLineSelection]);

  // Compact touch keeps a dragged range on screen instead of opening the
  // composer, so `pendingSelection` is non-null for the whole time the reviewer
  // may drag again — and a non-null `selectedLines` is exactly what puts Pierre
  // in controlled-selection mode. Feed the in-flight range back so the second
  // drag repaints and the finger stays tracked. Desktop never enters that state
  // through a preserved range, and gets no handler at all.
  const handlePierreLineSelectionChange = useCallback((range: SelectedLineRange | null) => {
    onLineSelection(range);
  }, [onLineSelection]);

  const handleGutterUtilityClick = useCallback((range: SelectedLineRange) => {
    const snapshot = selectionSnapshotRef.current;
    selectionSnapshotRef.current = null;
    const effectiveRange = rangeForGutterClick(range, snapshot);
    handleLineSelectionInteraction('gutter-comment-action', effectiveRange);
  }, [handleLineSelectionInteraction]);

  useEffect(() => {
    const root = diffContentRef.current;
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
    const handler = () => {
      requestAnimationFrame(() => {
        const selection = getDiffSelection(root);
        if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
        const anchorLine = getLineNumberFromNode(selection.anchorNode);
        const focusLine = getLineNumberFromNode(selection.focusNode);
        if (anchorLine == null || focusLine == null) return;
        if (anchorLine === focusLine) return;
        const side = getSideFromNode(selection.anchorNode);
        toolbarHostRef.current?.handleLineSelectionEnd({
          start: Math.min(anchorLine, focusLine),
          end: Math.max(anchorLine, focusLine),
          side,
        });
        selection.removeAllRanges();
      });
    };
    root.addEventListener('mouseup', handler, true);
    return () => {
      if (clearTimer) clearTimeout(clearTimer);
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('pointercancel', onCancel, true);
      root.removeEventListener('pointerup', onPointerUp, true);
      root.removeEventListener('mouseup', handler, true);
    };
    // The diff body unmounts while collapsed or previewed; re-attach to the new one.
  }, [collapsed, markdownPreviewEnabled]);

  const handlePierreLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    handleLineSelectionInteraction('range-gesture', range);
  }, [handleLineSelectionInteraction]);
  // N / Shift+N: the next / previous change of this file (#1543). Single-file
  // diffs are not line-virtualized, so every change's first line is in the DOM.
  const changes = useMemo(() => listDiffChanges(augmentedDiff?.hunks), [augmentedDiff]);
  // The change the last jump landed on, while it is still on screen.
  const changeCursorRef = useRef<number | null>(null);
  useEffect(() => {
    changeCursorRef.current = null;
  }, [changes]);
  const jumpChange = useCallback((direction: 'next' | 'prev'): boolean => {
    const container = containerRef.current;
    if (!container || changes.length === 0) return false;
    const view = container.getBoundingClientRect();
    const readingLine = readingLineFor(view, direction, {
      atTop: container.scrollTop <= 1,
      atBottom: container.scrollTop + container.clientHeight >= container.scrollHeight - 1,
    });
    const elements = changes.map((change) => findChangeElement(container, change));
    const placements = elements.map((el): ChangePlacement => {
      // Not rendered (should not happen here): count it by its order.
      if (!el) return 'after';
      return placementOf(el.getBoundingClientRect(), readingLine);
    });
    const cursor = changeCursorRef.current;
    const cursorEl = cursor != null ? elements[cursor] : null;
    const cursorRect = cursorEl?.getBoundingClientRect();
    const cursorOnScreen = !!cursorRect && cursorRect.bottom > view.top && cursorRect.top < view.bottom;
    const target = resolveChangeJump(placements, direction, cursorOnScreen ? cursor : null);
    // No change that way: leave the key to anyone else.
    if (target == null) return false;
    const el = elements[target];
    if (!el) return false;
    changeCursorRef.current = target;
    const rect = el.getBoundingClientRect();
    const top = container.scrollTop + (rect.top - view.top) - view.height / 2 + rect.height / 2;
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
    return true;
  }, [changes]);

  useEffect(() => {
    if (!changeNavigation || collapsed || markdownPreviewEnabled) return;
    const handler = (e: KeyboardEvent) => {
      const direction = changeJumpDirection(e);
      if (!direction || changes.length === 0) return;
      if (jumpChange(direction)) e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [changeNavigation, collapsed, markdownPreviewEnabled, changes, jumpChange]);

  // Token interaction handlers (code area clicks)
  const handleTokenClick = useCallback((props: DiffTokenEventBaseProps, event: MouseEvent) => {
    // Alt is an unadvertised alias for the same References-panel path; the
    // meta/ctrl branch itself is unchanged.
    if ((event.metaKey || event.ctrlKey || event.altKey) && onCodeNavRequest) {
      onCodeNavRequest(buildCodeNavRequest(props, filePath));
      return;
    }
    toolbarHostRef.current?.handleTokenClick(props, event);
  }, [filePath, onCodeNavRequest]);

  const handleTokenEnter = useCallback((props: DiffTokenEventBaseProps, event: PointerEvent) => {
    // Only where a card can actually open. The class carries a pointer cursor
    // (now !important, so it genuinely wins over Pierre's I-beam), and painting
    // it unconditionally promised clickability on every token even with hover
    // cards switched off.
    if (onTokenHoverEnter) props.tokenElement.classList.add('pn-token-hover');
    if ((event.metaKey || event.ctrlKey) && onCodeNavRequest) {
      props.tokenElement.classList.add('pn-token-nav');
    }
    onTokenHoverEnter?.(props, filePath);
  }, [filePath, onCodeNavRequest, onTokenHoverEnter]);

  const handleTokenLeave = useCallback((props: DiffTokenEventBaseProps) => {
    props.tokenElement.classList.remove('pn-token-hover');
    props.tokenElement.classList.remove('pn-token-nav');
    onTokenHoverLeave?.();
  }, [onTokenHoverLeave]);

  const splitGridStyle = useMemo(() => {
    if (!isSplitLayout || diffOverflow === 'wrap') return undefined;
    return {
      '--split-left': `${splitRatio}fr`,
      '--split-right': `${1 - splitRatio}fr`,
    } as React.CSSProperties;
  }, [diffOverflow, isSplitLayout, splitRatio]);

  // File-scoped comments render below the path, above the hunks (full text, no
  // truncation) — line-scoped annotations stay inline in the gutter.
  const fileComments = useMemo(
    () => annotations.filter(isFileScopedAnnotation),
    [annotations],
  );
  const fileCommentsOutsidePreview = useMemo(
    () => fileComments.filter((comment) => !comment.markdownPreview),
    [fileComments],
  );

  // Files over the review size cap arrive as a contents-free stub, which
  // renders as an empty body. Say so instead of showing a bare header.
  const isOversizedStub = useMemo(() => isOversizedReviewStubPatch(patch), [patch]);

  // The general fallback under that specific case: any OTHER hunkless binary
  // chunk (a genuine binary file, or a stub shape the marker does not cover)
  // still renders an empty body and still has to say why. Gated on the marker
  // so a marker-carrying stub is explained exactly once, by the message above.
  const isContentlessBinary = useMemo(
    () => !isOversizedStub && isContentlessBinaryPatch(patch),
    [patch, isOversizedStub],
  );

  // A hunkless chunk for an image path previews the images instead (#1598);
  // the notices above stay its fallback.
  const isImagePreview = useMemo(
    () => imagePreviewAvailable && isImagePreviewCandidate(patch, filePath, oldPath),
    [imagePreviewAvailable, patch, filePath, oldPath],
  );

  // Replay a selected line/range comment's anchor as the controlled highlight so
  // clicking it (inline card or sidebar) lights up its lines. A live compose
  // selection (pendingSelection) wins while the toolbar is open; file-scoped
  // comments have no meaningful line so they don't paint a highlight.
  const selectedAnnotationRange = useMemo<SelectedLineRange | null>(() => {
    if (!selectedAnnotationId) return null;
    const ann = annotations.find((a) => a.id === selectedAnnotationId);
    if (!ann || isFileScopedAnnotation(ann)) return null;
    return lineRangeForAnnotation(ann);
  }, [selectedAnnotationId, annotations]);

  return (
    <div className="h-full flex flex-col">
      {/* `relative` anchors this file's horizontal scrollbar to the header's
          bottom edge (#1048) — same placement as the all-files surface. */}
      <div className="relative flex-none">
      <FileHeader
        filePath={filePath}
        patch={patch}
        status={status}
        oldPath={oldPath}
        isViewed={isViewed}
        isGenerated={isGenerated}
        isTest={isTest}
        onToggleViewed={onToggleViewed}
        showViewedControl={showViewedControls}
        collapseToggle={onToggleCollapsed && (
          <svg
            className={`mr-1.5 h-3.5 w-3.5 flex-none text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : 'rotate-0'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
          </svg>
        )}
        onCollapseToggle={onToggleCollapsed}
        isStaged={isStaged}
        isStaging={isStaging}
        onStage={onStage}
        canStage={canStage}
        showStageControl={showStageControls}
        stageError={stageError}
        onFileComment={setFileCommentAnchor}
        renderMarkdownView={canPreviewMarkdown
          ? ({ iconOnly, touch }) => (
            <MarkdownViewMenu
              filePath={filePath}
              view={markdownView}
              views={markdownViews}
              status={status}
              onChoose={chooseMarkdownView}
              iconOnly={iconOnly}
              touch={touch}
              disabledReason={markdownViewDisabledReason}
            />
          )
          : undefined}
      />
      {!collapsed && !markdownPreviewEnabled && diffOverflow !== 'wrap' && (
        <DiffHScrollbar className="absolute inset-x-2 bottom-0 z-30" />
      )}
      </div>

      {!collapsed && (
        <OverlayScrollArea
          className={`flex-1 min-h-0 relative ${isDraggingSplit ? 'select-none' : ''}`}
          overflowX="scroll"
          overflowY="auto"
          onViewportReady={onViewportReady}
        >
          {markdownPreviewEnabled ? (
            <>
              {/* Comments made in the preview are highlighted in it; the
                  banner keeps the header's file comments. */}
              <FileCommentBanner
                comments={fileCommentsOutsidePreview}
                selectedAnnotationId={selectedAnnotationId}
                onSelect={onSelectAnnotation}
                onEdit={onEditAnnotation}
                onDelete={onDeleteAnnotation}
              />
              <React.Suspense fallback={<MarkdownPreviewPending />}>
              <MarkdownFilePreview
                filePath={filePath}
                oldPath={oldPath}
                status={status}
                patch={patch}
                contents={fileContentsResult}
                imageSnapshotId={imageSnapshotId ?? reviewSnapshotId}
                imagesAvailable={imagePreviewAvailable}
                reviewFilePaths={reviewFilePaths}
                onOpenReviewFile={onOpenReviewFile}
                variant="single"
                view={renderedViewOf(markdownView)}
                onViewChange={(view) => setMarkdownPreview(true, view)}
              />
              </React.Suspense>
            </>
          ) : (
            <>
              {/* Specific first, general second, and never both: whichever applies,
                  a card with no hunks to draw says why instead of reading as empty. */}
              {isImagePreview ? (
                <ImageDiffPreview
                  filePath={filePath}
                  status={status ?? 'modified'}
                  snapshotId={imageSnapshotId ?? reviewSnapshotId}
                  variant="single"
                  compact={compactTouchLayout}
                  fallback={isOversizedStub ? <OversizedFileNotice /> : isContentlessBinary ? <BinaryFileNotice /> : null}
                  tooLargeFallback={isOversizedStub ? <OversizedFileNotice /> : undefined}
                />
              ) : (
                <>
                  {isOversizedStub && <OversizedFileNotice />}
                  {isContentlessBinary && <BinaryFileNotice />}
                </>
              )}
              {packageChangesAvailable && isPackageChangePath(filePath) && (
                <PackageChangesCard
                  key={`${imageSnapshotId ?? reviewSnapshotId ?? ''}:${filePath}`}
                  filePath={filePath}
                  reviewBase={reviewBase}
                  reviewSnapshotId={imageSnapshotId ?? reviewSnapshotId}
                  compactTouchLayout={compactTouchLayout}
                />
              )}
              <FileCommentBanner
                comments={fileComments}
                selectedAnnotationId={selectedAnnotationId}
                onSelect={onSelectAnnotation}
                onEdit={onEditAnnotation}
                onDelete={onDeleteAnnotation}
              />
              <div className="p-4" ref={diffContentRef}>
                <div ref={splitSurfaceRef} className="relative min-w-0" style={splitGridStyle}>
                  {isSplitLayout && diffOverflow !== 'wrap' && (
                    <div
                      className="absolute top-0 bottom-0 z-10 cursor-col-resize group"
                      style={{ left: `${splitRatio * 100}%`, width: 9, marginLeft: -4 }}
                      onPointerDown={handleSplitDragStart}
                      onDoubleClick={resetSplitRatio}
                    >
                      <div className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border transition-[width,background-color] group-hover:w-0.5 group-hover:bg-primary/50 group-active:w-0.5 group-active:bg-primary/70" />
                    </div>
                  )}
                  <PierreDiffContent
                    filePath={filePath}
                    fileDiff={augmentedDiff}
                    pierreTheme={pierreTheme}
                    diffStyle={diffStyle}
                    diffOverflow={diffOverflow}
                    diffIndicators={diffIndicators}
                    lineDiffType={lineDiffType}
                    disableLineNumbers={disableLineNumbers}
                    disableBackground={disableBackground}
                    expandUnchanged={expandUnchanged}
                    mergedAnnotations={mergedAnnotations}
                    pendingSelection={pendingSelection ?? selectedAnnotationRange}
                    onLineSelectionEnd={handlePierreLineSelectionEnd}
                    onLineSelectionChange={compactTouchLayout ? handlePierreLineSelectionChange : undefined}
                    onGutterUtilityClick={handleGutterUtilityClick}
                    renderAnnotation={renderAnnotation}
                    onTokenClick={handleTokenClick}
                    onTokenEnter={handleTokenEnter}
                    onTokenLeave={handleTokenLeave}
                  />
                </div>
              </div>
              <ToolbarHost
                ref={toolbarHostRef}
                patch={patch}
                filePath={filePath}
                isFocused={isFocused}
                onLineSelection={onLineSelection}
                onAddAnnotation={onAddAnnotation}
                onEditAnnotation={onEditAnnotation}
                aiAvailable={aiAvailable}
                onAskAI={onAskAI}
                isAILoading={isAILoading}
                onViewAIResponse={onViewAIResponse}
                aiHistoryMessages={aiHistoryMessages}
              />
            </>
          )}
        </OverlayScrollArea>
      )}

      {/* The header's Comment button works in every view (diff, preview,
          collapsed), so its composer is mounted outside them. */}
      {fileCommentAnchor && (
        <CommentPopover
          anchorEl={fileCommentAnchor}
          contextText={filePath.split('/').pop() || filePath}
          isGlobal={false}
          draftKey={`file:${prUrl ?? ''}:${prDiffScope ?? ''}:${filePath}`}
          onSubmit={(text) => {
            onAddFileComment(text);
            setFileCommentAnchor(null);
          }}
          onClose={() => setFileCommentAnchor(null)}
        />
      )}
    </div>
  );
};
