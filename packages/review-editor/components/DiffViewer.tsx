import React, { useMemo, useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import { FileDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import { getSingularPatch, processFile, parseDiffFromFile } from '@pierre/diffs';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, DiffAnnotationMetadata, TokenAnnotationMeta, ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import type { DiffTokenEventBaseProps } from '@pierre/diffs';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { storage } from '@plannotator/ui/utils/storage';
import { detectLanguage } from '../utils/detectLanguage';
import { useAnnotationToolbar } from '../hooks/useAnnotationToolbar';
import { useConfigValue } from '@plannotator/ui/config';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { useOverlayViewport } from '@plannotator/ui/hooks/useOverlayViewport';
import { getEnabledLabels } from './ConventionalLabelPicker';
import { FileHeader } from './FileHeader';
import { InlineAnnotation } from './InlineAnnotation';
import { InlineAIMarker } from './InlineAIMarker';
import { AnnotationToolbar } from './AnnotationToolbar';
import type { AIChatEntry } from '../hooks/useAIChat';
import { SuggestionModal } from './SuggestionModal';
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
  pierreTheme: { type: 'dark' | 'light'; css: string };
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  mergedAnnotations: DiffLineAnnotation<DiffAnnotationMetadata>[];
  pendingSelection: SelectedLineRange | null;
  onLineSelectionEnd: (range: SelectedLineRange | null) => void;
  renderAnnotation: (annotation: { side: string; lineNumber: number; metadata?: DiffAnnotationMetadata }) => React.ReactNode;
  renderHoverUtility: (getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => React.ReactNode;
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
  mergedAnnotations,
  pendingSelection,
  onLineSelectionEnd,
  renderAnnotation,
  renderHoverUtility,
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
        diffStyle,
        overflow: diffOverflow,
        diffIndicators,
        lineDiffType,
        disableLineNumbers,
        disableBackground,
        hunkSeparators: 'line-info',
        enableLineSelection: true,
        enableHoverUtility: true,
        onLineSelectionEnd,
        onTokenClick,
        onTokenEnter,
        onTokenLeave,
      }}
      lineAnnotations={mergedAnnotations}
      selectedLines={pendingSelection || undefined}
      renderAnnotation={renderAnnotation}
      renderHoverUtility={renderHoverUtility}
    />
  );
}, (prev, next) => (
  prev.filePath === next.filePath &&
  prev.fileDiff === next.fileDiff &&
  prev.pierreTheme.type === next.pierreTheme.type &&
  prev.pierreTheme.css === next.pierreTheme.css &&
  prev.diffStyle === next.diffStyle &&
  prev.diffOverflow === next.diffOverflow &&
  prev.diffIndicators === next.diffIndicators &&
  prev.lineDiffType === next.lineDiffType &&
  prev.disableLineNumbers === next.disableLineNumbers &&
  prev.disableBackground === next.disableBackground &&
  prev.mergedAnnotations === next.mergedAnnotations &&
  prev.pendingSelection === next.pendingSelection &&
  prev.onLineSelectionEnd === next.onLineSelectionEnd &&
  prev.renderAnnotation === next.renderAnnotation &&
  prev.renderHoverUtility === next.renderHoverUtility &&
  prev.onTokenClick === next.onTokenClick &&
  prev.onTokenEnter === next.onTokenEnter &&
  prev.onTokenLeave === next.onTokenLeave
));

interface DiffViewerProps {
  patch: string;
  filePath: string;
  oldPath?: string;
  /** Base branch override used for file-content lookups (branch / merge-base modes only). */
  reviewBase?: string;
  isFocused?: boolean;
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  hideWhitespace?: boolean;
  fontFamily?: string;
  fontSize?: string;
  annotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
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
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  patch,
  filePath,
  oldPath,
  reviewBase,
  isFocused = false,
  diffStyle,
  diffOverflow,
  diffIndicators = 'bars',
  lineDiffType,
  disableLineNumbers,
  disableBackground,
  hideWhitespace,
  fontFamily,
  fontSize,
  annotations,
  selectedAnnotationId,
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
}) => {
  const { theme, colorTheme, resolvedMode } = useTheme();
  // containerRef must point at the actual scrolling element (the
  // OverlayScrollbars viewport), not the OverlayScrollArea host. `viewport`
  // is state so effects re-run once the library has mounted the viewport.
  const { ref: containerRef, viewport, onViewportReady } =
    useOverlayViewport<HTMLDivElement>();
  const splitSurfaceRef = useRef<HTMLDivElement>(null);
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

  const toolbar = useAnnotationToolbar({ patch, filePath, isFocused, onLineSelection, onAddAnnotation, onEditAnnotation });
  const conventionalCommentsEnabled = useConfigValue('conventionalComments');
  const conventionalLabelsJson = useConfigValue('conventionalLabels');
  const enabledLabels = useMemo(() => getEnabledLabels(conventionalLabelsJson), [conventionalLabelsJson]);

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
    fetch(`/api/file-content?${params}`, { signal: controller.signal })
      .then(res => res.ok ? res.json() : null)
      .then((data: { oldContent: string | null; newContent: string | null } | null) => {
        if (data && (data.oldContent != null || data.newContent != null)) {
          setFileContents({ forPath: filePath, old: data.oldContent, new: data.newContent });
        }
      })
      .catch(() => {}); // Silent fallback — no expansion in demo mode
    return () => controller.abort();
  }, [filePath, oldPath, reviewBase]);

  // Re-parse the patch with full file contents so hunk indices are computed
  // against the complete file (isPartial: false), enabling expansion.
  // When hideWhitespace is on, recompute the diff from file contents to
  // exclude whitespace-only changes (like GitHub's ?w=1).
  const augmentedDiff = useMemo(() => {
    if (!fileContents || fileContents.forPath !== filePath || (fileContents.old == null && fileContents.new == null)) return fileDiff;
    try {
      if (hideWhitespace && fileContents.old != null && fileContents.new != null) {
        const normalize = (s: string) => s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n');
        return parseDiffFromFile(
          { name: oldPath || filePath, contents: normalize(fileContents.old) },
          { name: filePath, contents: normalize(fileContents.new) },
        );
      }
      const result = processFile(patch, {
        oldFile: fileContents.old != null ? { name: oldPath || filePath, contents: fileContents.old } : undefined,
        newFile: fileContents.new != null ? { name: filePath, contents: fileContents.new } : undefined,
      });
      return result || fileDiff;
    } catch {
      return fileDiff;
    }
  }, [patch, filePath, oldPath, fileContents, fileDiff, hideWhitespace]);

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

  // Scroll to selected annotation when it changes
  useEffect(() => {
    if (!selectedAnnotationId || !containerRef.current) return;

    const timeoutId = setTimeout(() => {
      const annotationEl = containerRef.current?.querySelector(
        `[data-annotation-id="${selectedAnnotationId}"]`
      );
      if (annotationEl) {
        annotationEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [selectedAnnotationId, viewport]);

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
  }, [searchQuery, searchMatches, filePath, diffStyle, diffOverflow, diffIndicators, lineDiffType, disableLineNumbers, disableBackground, augmentedDiff, viewport]);

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
  }, [activeSearchMatch, filePath, diffStyle, diffOverflow, diffIndicators, lineDiffType, disableLineNumbers, disableBackground, viewport]);

  // Map annotations to @pierre/diffs format
  const lineAnnotations = useMemo(() => {
    return annotations
      .filter(ann => (ann.scope ?? 'line') === 'line')
      .map(ann => ({
        side: ann.side === 'new' ? 'additions' as const : 'deletions' as const,
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
    if (ann) toolbar.startEdit(ann);
  }, [annotations, toolbar.startEdit]);

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
        onSelect={onSelectAnnotation}
        onEdit={handleEdit}
        onDelete={onDeleteAnnotation}
      />
    );
  }, [filePath, onSelectAnnotation, handleEdit, onDeleteAnnotation, onClickAIMarker]);

  // Render hover utility (+ button).
  // Pierre manages visibility imperatively — it inserts/removes the slot
  // container on line hover. We must always return a button; calling
  // getHoveredLine() to gate rendering would return stale data because
  // Pierre's hover state changes don't trigger React re-renders.
  const renderHoverUtility = useCallback((getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => {
    return (
      <button
        className="hover-add-comment"
        onClick={(e) => {
          e.stopPropagation();
          const line = getHoveredLine();
          if (!line) return;
          toolbar.handleLineSelectionEnd({
            start: line.lineNumber,
            end: line.lineNumber,
            side: line.side,
          });
        }}
      >
        +
      </button>
    );
  }, [toolbar.handleLineSelectionEnd]);

  // Token interaction handlers (code area clicks)
  const handleTokenClick = useCallback((props: DiffTokenEventBaseProps, event: MouseEvent) => {
    toolbar.handleTokenClick(props, event);
  }, [toolbar.handleTokenClick]);

  const handleTokenEnter = useCallback((props: DiffTokenEventBaseProps) => {
    props.tokenElement.classList.add('pn-token-hover');
  }, []);

  const handleTokenLeave = useCallback((props: DiffTokenEventBaseProps) => {
    props.tokenElement.classList.remove('pn-token-hover');
  }, []);

  // Inject resolved colors into @pierre/diffs shadow DOM.
  // CSS custom properties don't cross the shadow boundary, so we read computed
  // values and pass them via unsafeCSS. Single state object avoids split renders.
  const [pierreTheme, setPierreTheme] = useState<{ type: 'dark' | 'light'; css: string }>(() => {
    // Compute initial theme synchronously to avoid a flash of unstyled dark content
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--background').trim();
    const fg = styles.getPropertyValue('--foreground').trim();
    if (!bg || !fg) return { type: resolvedMode ?? 'dark', css: '' };
    return { type: resolvedMode ?? 'dark', css: `
      :host, [data-diff], [data-file], [data-diffs-header], [data-error-wrapper], [data-virtualizer-buffer] {
        --diffs-bg: ${bg} !important; --diffs-fg: ${fg} !important;
        --diffs-dark-bg: ${bg}; --diffs-light-bg: ${bg}; --diffs-dark: ${fg}; --diffs-light: ${fg};
      }
      pre, code { background-color: ${bg} !important; }
    `};
  });

  useEffect(() => {
    requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      const bg = styles.getPropertyValue('--background').trim();
      const fg = styles.getPropertyValue('--foreground').trim();
      const muted = styles.getPropertyValue('--muted').trim();
      const primary = styles.getPropertyValue('--primary').trim();
      if (!bg || !fg) return;

      const fontCSS = fontFamily || fontSize ? `
          pre, code, [data-line-content], [data-column-number] {
            ${fontFamily ? `font-family: '${fontFamily}', monospace !important;` : ''}
            ${fontSize ? `font-size: ${fontSize} !important; line-height: 1.5 !important;` : ''}
          }` : '';

      setPierreTheme({
        type: resolvedMode,
        css: `
          :host, [data-diff], [data-file], [data-diffs-header], [data-error-wrapper], [data-virtualizer-buffer] {
            --diffs-bg: ${bg} !important;
            --diffs-fg: ${fg} !important;
            --diffs-dark-bg: ${bg};
            --diffs-light-bg: ${bg};
            --diffs-dark: ${fg};
            --diffs-light: ${fg};
          }
          pre, code { background-color: ${bg} !important; }
          [data-file-info] { background-color: ${muted} !important; }
          [data-column-number] { background-color: ${bg} !important; }
          [data-diffs-header] [data-title] { display: none !important; }
          [data-diff-type='split'][data-overflow='scroll'] {
            grid-template-columns:
              minmax(0, var(--split-left, 1fr))
              minmax(0, var(--split-right, 1fr)) !important;
          }
          [data-diff-type='split'][data-overflow='scroll'] > [data-code][data-deletions],
          [data-diff-type='split'][data-overflow='scroll'] > [data-code][data-additions],
          [data-diff-type='split'][data-overflow='scroll'] > [data-code][data-deletions] [data-content],
          [data-diff-type='split'][data-overflow='scroll'] > [data-code][data-additions] [data-content] {
            min-width: 0 !important;
          }
          .pn-token-hover {
            text-decoration: underline;
            text-decoration-color: ${primary || 'oklch(0.70 0.20 280)'};
            text-decoration-thickness: 1.5px;
            text-underline-offset: 2px;
            cursor: pointer;
          }
          ${fontCSS}
        `,
      });
    });
  }, [resolvedMode, colorTheme, fontFamily, fontSize]);

  const splitGridStyle = useMemo(() => {
    if (!isSplitLayout || diffOverflow === 'wrap') return undefined;
    return {
      '--split-left': `${splitRatio}fr`,
      '--split-right': `${1 - splitRatio}fr`,
    } as React.CSSProperties;
  }, [diffOverflow, isSplitLayout, splitRatio]);

  return (
    <div className="h-full flex flex-col">
      <FileHeader
        filePath={filePath}
        patch={patch}
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
        onMouseMove={toolbar.handleMouseMove}
      >
        <div className="p-4">
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
              mergedAnnotations={mergedAnnotations}
              pendingSelection={pendingSelection}
              onLineSelectionEnd={toolbar.handleLineSelectionEnd}
              renderAnnotation={renderAnnotation}
              renderHoverUtility={renderHoverUtility}
              onTokenClick={handleTokenClick}
              onTokenEnter={handleTokenEnter}
              onTokenLeave={handleTokenLeave}
            />
          </div>
        </div>

      {toolbar.toolbarState && !toolbar.showCodeModal && (
        <AnnotationToolbar
          toolbarState={toolbar.toolbarState}
          toolbarRef={toolbar.toolbarRef}
          commentText={toolbar.commentText}
          setCommentText={toolbar.setCommentText}
          suggestedCode={toolbar.suggestedCode}
          setSuggestedCode={toolbar.setSuggestedCode}
          showSuggestedCode={toolbar.showSuggestedCode}
          setShowSuggestedCode={toolbar.setShowSuggestedCode}
          selectedOriginalCode={toolbar.selectedOriginalCode}
          setShowCodeModal={toolbar.setShowCodeModal}
          isEditing={!!toolbar.editingAnnotationId}
          onSubmit={toolbar.handleSubmitAnnotation}
          onDismiss={toolbar.handleDismiss}
          onCancel={toolbar.handleCancel}
          conventionalCommentsEnabled={conventionalCommentsEnabled}
          conventionalLabel={toolbar.conventionalLabel}
          onConventionalLabelChange={toolbar.setConventionalLabel}
          decorations={toolbar.decorations}
          onDecorationsChange={toolbar.setDecorations}
          enabledLabels={enabledLabels}
          aiAvailable={aiAvailable}
          onAskAI={onAskAI}
          isAILoading={isAILoading}
          onViewAIResponse={onViewAIResponse}
          aiHistoryMessages={aiHistoryMessages}
        />
      )}

      {toolbar.showCodeModal && (
        <SuggestionModal
          filePath={filePath}
          toolbarState={toolbar.toolbarState}
          selectedOriginalCode={toolbar.selectedOriginalCode}
          suggestedCode={toolbar.suggestedCode}
          setSuggestedCode={toolbar.setSuggestedCode}
          modalLayout={toolbar.modalLayout}
          setModalLayout={toolbar.setModalLayout}
          onClose={() => toolbar.setShowCodeModal(false)}
        />
      )}

      {fileCommentAnchor && (
        <CommentPopover
          anchorEl={fileCommentAnchor}
          contextText={filePath.split('/').pop() || filePath}
          isGlobal={false}
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
