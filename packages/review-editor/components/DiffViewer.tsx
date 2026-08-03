import React, { useMemo, useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import { FileDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import { getSingularPatch, processFile } from '@pierre/diffs';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, DiffAnnotationMetadata, TokenAnnotationMeta, ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import type { DiffTokenEventBaseProps } from '@pierre/diffs';
import { usePierreTheme } from '../hooks/usePierreTheme';
import { useWorkerPoolThemeSync } from '../workerPool';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { storage } from '@plannotator/ui/utils/storage';
import { detectLanguage } from '../utils/detectLanguage';
import { buildCodeNavRequest } from '../utils/buildCodeNavRequest';
import { ToolbarHost, type ToolbarHostHandle } from './ToolbarHost';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { useOverlayViewport } from '@plannotator/ui/hooks/useOverlayViewport';
import { FileHeader } from './FileHeader';
import { FileCommentBanner } from './FileCommentBanner';
import { isFileScopedAnnotation, lineRangeForAnnotation } from '../utils/annotationScope';
import { lineAnnotationMetadata } from '../utils/annotationDisplay';
import type { AnnotationScrollTarget } from '../types';
import { getLineNumberFromNode, getSideFromNode, getDiffSelection } from '../utils/diffSelection';
import { isContentConsistentWithPatch } from '../utils/patchConsistency';
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
  /** Opaque diff snapshot used to reject mutable file-content lookups from another view. */
  reviewSnapshotId?: string;
  /** Current PR url + diff scope — used to namespace file-comment drafts so they don't leak across in-place PR switches. */
  prUrl?: string;
  prDiffScope?: string;
  isFocused?: boolean;
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
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel, decorations?: ConventionalDecoration[], tokenMeta?: TokenAnnotationMeta) => void;
  onAddFileComment: (text: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel | null, decorations?: ConventionalDecoration[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
  isViewed?: boolean;
  onToggleViewed?: () => void;
  isStaged?: boolean;
  isStaging?: boolean;
  onStage?: () => void;
  canStage?: boolean;
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
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  patch,
  filePath,
  oldPath,
  status,
  reviewBase,
  reviewSnapshotId,
  prUrl,
  prDiffScope,
  isFocused = false,
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
  onLineSelection,
  onAddAnnotation,
  onAddFileComment,
  onEditAnnotation,
  onSelectAnnotation,
  onDeleteAnnotation,
  isViewed = false,
  onToggleViewed,
  isStaged = false,
  isStaging = false,
  onStage,
  canStage = false,
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
}) => {
  const pierreTheme = usePierreTheme({ fontFamily, fontSize });
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

  // Parse patch into FileDiffMetadata for @pierre/diffs FileDiff component
  const fileDiff = useMemo(() => getSingularPatch(patch), [patch]);

  // Fetch full file contents for expandable context
  const [fileContents, setFileContents] = useState<{ forPath: string; old: string | null; new: string | null } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setFileContents(null);
    const params = new URLSearchParams({ path: filePath });
    if (oldPath) params.set('oldPath', oldPath);
    if (reviewBase) params.set('base', reviewBase);
    if (reviewSnapshotId) params.set('snapshot', reviewSnapshotId);
    fetch(`/api/file-content?${params}`, { signal: controller.signal })
      .then(res => res.ok ? res.json() : null)
      .then((data: { oldContent: string | null; newContent: string | null } | null) => {
        if (data && (data.oldContent != null || data.newContent != null)) {
          setFileContents({ forPath: filePath, old: data.oldContent, new: data.newContent });
        }
      })
      .catch(() => {}); // Silent fallback — no expansion in demo mode
    return () => controller.abort();
  }, [filePath, oldPath, reviewBase, reviewSnapshotId]);

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
      return result || fileDiff;
    } catch {
      return fileDiff;
    }
  }, [patch, filePath, oldPath, fileContents, fileDiff]);

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
  useEffect(() => {
    if (!scrollTargetAnnotation || !containerRef.current) return;
    const targetId = scrollTargetAnnotation.id;

    const timeoutId = setTimeout(() => {
      const annotationEl = containerRef.current?.querySelector(
        `[data-annotation-id="${targetId}"]`
      );
      if (annotationEl) {
        annotationEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [scrollTargetAnnotation, viewport]);

  // Apply search highlights to diff lines (including inside shadow DOM).
  // The query is already debounced upstream (useReviewSearch), so this runs synchronously.
  // activeSearchMatchId is NOT in deps — the swap effect handles that with O(1) updates.
  useEffect(() => {
    if (!containerRef.current) return;

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
  }, [searchQuery, searchMatches, filePath, diffStyle, diffOverflow, diffIndicators, lineDiffType, disableLineNumbers, disableBackground, expandUnchanged, augmentedDiff, viewport]);

  // Swap active search highlight instantly when stepping between matches.
  // This avoids a full rebuild just to change two elements' background color.
  useEffect(() => {
    if (!containerRef.current) return;
    swapActiveSearchHighlight(containerRef.current, activeSearchMatchId);
  }, [activeSearchMatchId, viewport]);

  // Scroll to active search match (with retry for lazy-rendered content)
  useEffect(() => {
    if (!activeSearchMatch || !containerRef.current) return;
    return retryScrollToSearchMatch(containerRef.current, activeSearchMatch);
  }, [activeSearchMatch, filePath, diffStyle, diffOverflow, diffIndicators, lineDiffType, disableLineNumbers, disableBackground, expandUnchanged, viewport]);

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
    if (!pendingSelection || !containerRef.current) return;
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
  }, [pendingSelection, filePath, augmentedDiff, viewport]);

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

  const handleGutterUtilityClick = useCallback((range: SelectedLineRange) => {
    toolbarHostRef.current?.handleLineSelectionEnd(range);
  }, []);

  useEffect(() => {
    const root = diffContentRef.current;
    if (!root) return;
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
    return () => root.removeEventListener('mouseup', handler, true);
  }, []);

  const handlePierreLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    toolbarHostRef.current?.handleLineSelectionEnd(range);
  }, []);

  // Token interaction handlers (code area clicks)
  const handleTokenClick = useCallback((props: DiffTokenEventBaseProps, event: MouseEvent) => {
    if ((event.metaKey || event.ctrlKey) && onCodeNavRequest) {
      onCodeNavRequest(buildCodeNavRequest(props, filePath));
      return;
    }
    toolbarHostRef.current?.handleTokenClick(props, event);
  }, [filePath, onCodeNavRequest]);

  const handleTokenEnter = useCallback((props: DiffTokenEventBaseProps, event: PointerEvent) => {
    props.tokenElement.classList.add('pn-token-hover');
    if ((event.metaKey || event.ctrlKey) && onCodeNavRequest) {
      props.tokenElement.classList.add('pn-token-nav');
    }
  }, [onCodeNavRequest]);

  const handleTokenLeave = useCallback((props: DiffTokenEventBaseProps) => {
    props.tokenElement.classList.remove('pn-token-hover');
    props.tokenElement.classList.remove('pn-token-nav');
  }, []);

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
      <FileHeader
        filePath={filePath}
        patch={patch}
        status={status}
        oldPath={oldPath}
        isViewed={isViewed}
        onToggleViewed={onToggleViewed}
        isStaged={isStaged}
        isStaging={isStaging}
        onStage={onStage}
        canStage={canStage}
        stageError={stageError}
        onFileComment={setFileCommentAnchor}
      />

      <OverlayScrollArea
        className={`flex-1 min-h-0 relative ${isDraggingSplit ? 'select-none' : ''}`}
        overflowX="scroll"
        onViewportReady={onViewportReady}
      >
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
      </OverlayScrollArea>
    </div>
  );
};
