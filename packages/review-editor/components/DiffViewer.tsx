import React, { useMemo, useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import { FileDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
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
const MarkdownFilePreview = React.lazy(async () => ({ default: (await import('./MarkdownFilePreview')).MarkdownFilePreview }));
import { fileViewOfRendered, renderedViewOf, type MarkdownPreviewView } from '../hooks/useMarkdownPreview';
import { MarkdownViewMenu } from './MarkdownViewMenu';
import { BinaryFileNotice } from './BinaryFileNotice';
import { FileCommentBanner } from './FileCommentBanner';
import { DiffBottomBar } from './DiffBottomBar';
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
import { NO_HOST_LINE_NOTES, projectHostLineNotes, type HostLineNote } from './hostLineNotes';
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
        ...(onLineSelectionChange ? { onLineSelectionChange } : {}),
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
  hostLineNotes?: readonly HostLineNote[];
  headerAccessory?: React.ReactNode;
  bodyOverride?: React.ReactNode;
  patch: string;
  filePath: string;
  oldPath?: string;
  status?: import('../types').DiffFileStatus;
  reviewBase?: string;
  contextExpansionAvailable?: boolean;
  reviewSnapshotId?: string;
  imagePreviewAvailable?: boolean;
  imageSnapshotId?: string;
  packageChangesAvailable?: boolean;
  prUrl?: string;
  prDiffScope?: string;
  isFocused?: boolean;
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
  compactTouchLayout?: boolean;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel, decorations?: ConventionalDecoration[], tokenMeta?: TokenAnnotationMeta) => void;
  onAddFileComment: (text: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string, conventionalLabel?: ConventionalLabel | null, decorations?: ConventionalDecoration[]) => void;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
  onExplainAnnotation?: (id: string) => void;
  agentFindingSources?: ReadonlySet<string>;
  isViewed?: boolean;
  onToggleViewed?: () => void;
  showViewedControls?: boolean;
  isGenerated?: boolean;
  isTest?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  isStaged?: boolean;
  isStaging?: boolean;
  onStage?: () => void;
  canStage?: boolean;
  showStageControls?: boolean;
  stageError?: string | null;
  searchQuery?: string;
  searchMatches?: ReviewSearchMatch[];
  activeSearchMatchId?: string | null;
  activeSearchMatch?: ReviewSearchMatch | null;
  aiAvailable?: boolean;
  onAskAI?: (question: string) => void;
  isAILoading?: boolean;
  onViewAIResponse?: (questionId?: string) => void;
  aiMessages?: AIChatEntry[];
  onClickAIMarker?: (questionId: string) => void;
  aiHistoryMessages?: AIChatEntry[];
  onCodeNavRequest?: (request: import('@plannotator/shared/code-nav').CodeNavRequest) => void;
  onTokenHoverEnter?: (props: DiffTokenEventBaseProps, filePath: string) => void;
  onTokenHoverLeave?: () => void;
  onTokenTarget?: import('../utils/tokenTarget').TokenTargetHandler;
  reviewFilePaths?: ReadonlySet<string>;
  onOpenReviewFile?: (filePath: string) => void;
  markdownView?: MarkdownFileView;
  onMarkdownViewChange?: (view: MarkdownFileView, how: 'chosen' | 'shown') => void;
  markdownPreviewSupported?: boolean;
  markdownViewDisabledReason?: string | null;
}

const MarkdownPreviewPending: React.FC = () => (
  <div className="min-h-full px-4 py-4 sm:px-6" data-markdown-preview="" data-markdown-preview-view="pending">
    <div role="status" data-markdown-preview-state="loading" className="mx-auto max-w-3xl rounded-md border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
      Loading the full Markdown file…
    </div>
  </div>
);

export const MarkdownPreviewFailed: React.FC<{ notice: React.ReactNode }> = ({ notice }) => (
  <div className="min-h-full px-4 py-4 sm:px-6" data-markdown-preview="" data-markdown-preview-view="failed">
    <div className="mx-auto max-w-3xl rounded-md border border-border/60 bg-muted/20 p-4 [&>[role=status]]:mb-0">
      {notice}
    </div>
  </div>
);

export const DiffViewer: React.FC<DiffViewerProps> = ({
  hostLineNotes = NO_HOST_LINE_NOTES,
  headerAccessory,
  bodyOverride,
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
  onExplainAnnotation,
  agentFindingSources,
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
  onTokenTarget,
  reviewFilePaths,
  onOpenReviewFile,
  markdownView: markdownViewProp,
  onMarkdownViewChange,
  markdownPreviewSupported = true,
  markdownViewDisabledReason = null,
}) => {
  const pierreTheme = usePierreTheme({ fontFamily, fontSize, compactTouchLayout });
  useWorkerPoolThemeSync(pierreTheme.syntaxTheme);
  const { ref: containerRef, viewport, onViewportReady } =
    useOverlayViewport<HTMLDivElement>();
  const splitSurfaceRef = useRef<HTMLDivElement>(null);
  const diffContentRef = useRef<HTMLDivElement>(null);
  const selectionSnapshotRef = useRef<DiffSelectionSnapshot | null>(null);
  const [fileCommentAnchor, setFileCommentAnchor] = useState<HTMLElement | null>(null);

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

  const fileDiff = useMemo(() => {
    const parsed = getSingularPatch(patch);
    parsed.cacheKey = `${filePath}#${hashString(patch)}`;
    return parsed;
  }, [patch, filePath]);

  const fileContentsResult = useFileContents({
    filePath,
    oldPath,
    reviewBase,
    reviewSnapshotId,
    enabled: contextExpansionAvailable,
  });
  const { fileContents } = fileContentsResult;
  const markdownSourcePath = markdownPreviewSourcePath(filePath, oldPath, status);
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

  const augmentedDiff = useMemo(() => {
    if (!fileContents || fileContents.forPath !== filePath || (fileContents.old == null && fileContents.new == null)) return fileDiff;
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
      result.cacheKey = `${filePath}#full#${hashString(patch)}`;
      return result;
    } catch {
      return fileDiff;
    }
  }, [patch, filePath, oldPath, fileContents, fileDiff]);

  const chooseMarkdownView = useCallback((view: MarkdownFileView) => {
    if (view !== 'source' && !markdownPreviewEnabled) onLineSelection(null);
    setMarkdownView(view, 'chosen');
  }, [markdownPreviewEnabled, onLineSelection, setMarkdownView]);

  const wasPreviewEnabledRef = useRef(markdownPreviewEnabled);
  useEffect(() => {
    if (markdownPreviewEnabled && !wasPreviewEnabledRef.current && pendingSelection && isFocused) onLineSelection(null);
    wasPreviewEnabledRef.current = markdownPreviewEnabled;
  }, [markdownPreviewEnabled]);

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
    if (!containerRef.current) return;
    containerRef.current.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    previousScrollFilePathRef.current = filePath;
  }, [filePath, viewport]);

  const prevFilePathRef = useRef(filePath);
  useEffect(() => {
    if (prevFilePathRef.current !== filePath) {
      prevFilePathRef.current = filePath;
      onLineSelection(null);
    }
  }, [filePath, onLineSelection]);

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
        viewport.scrollTop = lastGoodST;
      } else {
        lastGoodST = 0;
      }
    };

    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [viewport, filePath]);

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const handledScrollTargetRef = useRef<AnnotationScrollTarget | null>(null);
  useEffect(() => {
    if (!scrollTargetAnnotation || !containerRef.current) return;
    if (handledScrollTargetRef.current === scrollTargetAnnotation) return;
    const targetId = scrollTargetAnnotation.id;

    const target = annotationsRef.current.find((ann) => ann.id === targetId);
    if (target?.markdownPreview) {
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
      if (!target) return;
      if (!isFileScopedAnnotation(target)) {
        setMarkdownPreview(false);
        return;
      }
    }
    handledScrollTargetRef.current = scrollTargetAnnotation;

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

  useEffect(() => {
    if (!containerRef.current || markdownPreviewEnabled) return;
    swapActiveSearchHighlight(containerRef.current, activeSearchMatchId);
  }, [activeSearchMatchId, viewport, markdownPreviewEnabled]);

  useEffect(() => {
    if (!activeSearchMatch || !containerRef.current || markdownPreviewEnabled) return;
    return retryScrollToSearchMatch(containerRef.current, activeSearchMatch);
  }, [activeSearchMatch, filePath, diffStyle, diffOverflow, diffIndicators, lineDiffType, disableLineNumbers, disableBackground, expandUnchanged, viewport, markdownPreviewEnabled]);

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

  const lineAnnotations = useMemo(() => {
    return annotations
      .filter(ann => (ann.scope ?? 'line') === 'line')
      .map(ann => ({
        side: ann.side === 'new' ? 'additions' as const : 'deletions' as const,
        lineNumber: ann.lineEnd,
        metadata: lineAnnotationMetadata(ann),
      }));
  }, [annotations]);

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

  const hostNoteAnnotations = useMemo(
    () => projectHostLineNotes(hostLineNotes, filePath),
    [hostLineNotes, filePath],
  );
  const mergedAnnotations = useMemo(
    () => (hostNoteAnnotations.length > 0
      ? [...hostNoteAnnotations, ...lineAnnotations, ...aiLineAnnotations]
      : [...lineAnnotations, ...aiLineAnnotations]),
    [hostNoteAnnotations, lineAnnotations, aiLineAnnotations],
  );

  const handleEdit = useCallback((id: string) => {
    const ann = annotations.find(a => a.id === id);
    if (ann) toolbarHostRef.current?.startEdit(ann);
  }, [annotations]);

  const renderAnnotation = useCallback((annotation: { side: string; lineNumber: number; metadata?: DiffAnnotationMetadata }) => {
    if (!annotation.metadata) return null;

    if (annotation.metadata.kind === 'host-note') {
      const id = annotation.metadata.annotationId;
      return hostLineNotes.find((note) => note.id === id)?.render() ?? null;
    }

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
        onExplain={onExplainAnnotation}
        agentFindingSources={agentFindingSources}
        explainDisabled={isAILoading}
      />
    );
  }, [filePath, selectedAnnotationId, onSelectAnnotation, handleEdit, onDeleteAnnotation, onExplainAnnotation, agentFindingSources, isAILoading, onClickAIMarker, hostLineNotes]);

  const handleLineSelectionInteraction = useCallback((
    source: LineSelectionSource,
    range: SelectedLineRange | null,
  ) => {
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
  }, [collapsed, markdownPreviewEnabled]);

  const handlePierreLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    handleLineSelectionInteraction('range-gesture', range);
  }, [handleLineSelectionInteraction]);
  const changes = useMemo(() => listDiffChanges(augmentedDiff?.hunks), [augmentedDiff]);
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
      if (!el) return 'after';
      return placementOf(el.getBoundingClientRect(), readingLine);
    });
    const cursor = changeCursorRef.current;
    const cursorEl = cursor != null ? elements[cursor] : null;
    const cursorRect = cursorEl?.getBoundingClientRect();
    const cursorOnScreen = !!cursorRect && cursorRect.bottom > view.top && cursorRect.top < view.bottom;
    const target = resolveChangeJump(placements, direction, cursorOnScreen ? cursor : null);
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

  const handleTokenClick = useCallback((props: DiffTokenEventBaseProps, event: MouseEvent) => {
    onTokenTarget?.('click', props, filePath);
    if ((event.metaKey || event.ctrlKey || event.altKey) && onCodeNavRequest) {
      onCodeNavRequest(buildCodeNavRequest(props, filePath));
      return;
    }
    toolbarHostRef.current?.handleTokenClick(props, event);
  }, [filePath, onCodeNavRequest, onTokenTarget]);

  const handleTokenEnter = useCallback((props: DiffTokenEventBaseProps, event: PointerEvent) => {
    if (onTokenHoverEnter) props.tokenElement.classList.add('pn-token-hover');
    if ((event.metaKey || event.ctrlKey) && onCodeNavRequest) {
      props.tokenElement.classList.add('pn-token-nav');
    }
    onTokenTarget?.('enter', props, filePath);
    onTokenHoverEnter?.(props, filePath);
  }, [filePath, onCodeNavRequest, onTokenHoverEnter, onTokenTarget]);

  const handleTokenLeave = useCallback((props: DiffTokenEventBaseProps) => {
    props.tokenElement.classList.remove('pn-token-hover');
    props.tokenElement.classList.remove('pn-token-nav');
    onTokenTarget?.('leave', props, filePath);
    onTokenHoverLeave?.();
  }, [filePath, onTokenHoverLeave, onTokenTarget]);

  const splitGridStyle = useMemo(() => {
    if (!isSplitLayout || diffOverflow === 'wrap') return undefined;
    return {
      '--split-left': `${splitRatio}fr`,
      '--split-right': `${1 - splitRatio}fr`,
    } as React.CSSProperties;
  }, [diffOverflow, isSplitLayout, splitRatio]);

  const fileComments = useMemo(
    () => annotations.filter(isFileScopedAnnotation),
    [annotations],
  );
  const fileCommentsOutsidePreview = useMemo(
    () => fileComments.filter((comment) => !comment.markdownPreview),
    [fileComments],
  );

  const isOversizedStub = useMemo(() => isOversizedReviewStubPatch(patch), [patch]);

  const isContentlessBinary = useMemo(
    () => !isOversizedStub && isContentlessBinaryPatch(patch),
    [patch, isOversizedStub],
  );

  const isImagePreview = useMemo(
    () => imagePreviewAvailable && isImagePreviewCandidate(patch, filePath, oldPath),
    [imagePreviewAvailable, patch, filePath, oldPath],
  );

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
        accessory={headerAccessory}
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

      {!collapsed && bodyOverride ? (
        <div className="flex-1 min-h-0 relative flex flex-col" data-diff-body-override>{bodyOverride}</div>
      ) : !collapsed && (
        <OverlayScrollArea
          className={`flex-1 min-h-0 relative ${isDraggingSplit ? 'select-none' : ''}`}
          overflowX="scroll"
          overflowY="auto"
          onViewportReady={onViewportReady}
        >
          {markdownPreviewEnabled ? (
            <>
              <FileCommentBanner
                comments={fileCommentsOutsidePreview}
                selectedAnnotationId={selectedAnnotationId}
                onSelect={onSelectAnnotation}
                onEdit={onEditAnnotation}
                onDelete={onDeleteAnnotation}
                onExplain={onExplainAnnotation}
                agentFindingSources={agentFindingSources}
                explainDisabled={isAILoading}
              />
              <LazyBlockBoundary fallback={(notice) => <MarkdownPreviewFailed notice={notice} />}>
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
              </LazyBlockBoundary>
            </>
          ) : (
            <>
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
                onExplain={onExplainAnnotation}
                agentFindingSources={agentFindingSources}
                explainDisabled={isAILoading}
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
      {!collapsed && !bodyOverride && !markdownPreviewEnabled && diffOverflow !== 'wrap' && <DiffBottomBar root={viewport} />}

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
