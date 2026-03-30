import React, { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import { FileDiff } from '@pierre/diffs/react';
import { getSingularPatch, processFile } from '@pierre/diffs';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, DiffAnnotationMetadata } from '@plannotator/ui/types';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { storage } from '@plannotator/ui/utils/storage';
import { detectLanguage } from '../utils/detectLanguage';
import { useAnnotationToolbar } from '../hooks/useAnnotationToolbar';
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

interface DiffViewerProps {
  patch: string;
  filePath: string;
  oldPath?: string;
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  fontFamily?: string;
  fontSize?: string;
  annotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string) => void;
  onAddFileComment: (text: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string) => void;
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
  diffStyle,
  diffOverflow,
  diffIndicators = 'bars',
  lineDiffType,
  disableLineNumbers,
  disableBackground,
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
  const containerRef = useRef<HTMLDivElement>(null);
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
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setIsDraggingSplit(true);

    const onMove = (e: PointerEvent) => {
      const ratio = (e.clientX - rect.left) / rect.width;
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

  const toolbar = useAnnotationToolbar({ patch, filePath, onLineSelection, onAddAnnotation, onEditAnnotation });

  // Parse patch into FileDiffMetadata for @pierre/diffs FileDiff component
  const fileDiff = useMemo(() => getSingularPatch(patch), [patch]);

  // Fetch full file contents for expandable context
  const [fileContents, setFileContents] = useState<{ forPath: string; old: string | null; new: string | null } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setFileContents(null);
    const params = new URLSearchParams({ path: filePath });
    if (oldPath) params.set('oldPath', oldPath);
    fetch(`/api/file-content?${params}`, { signal: controller.signal })
      .then(res => res.ok ? res.json() : null)
      .then((data: { oldContent: string | null; newContent: string | null } | null) => {
        if (data && (data.oldContent != null || data.newContent != null)) {
          setFileContents({ forPath: filePath, old: data.oldContent, new: data.newContent });
        }
      })
      .catch(() => {}); // Silent fallback — no expansion in demo mode
    return () => controller.abort();
  }, [filePath, oldPath]);

  // Re-parse the patch with full file contents so hunk indices are computed
  // against the complete file (isPartial: false), enabling expansion.
  const augmentedDiff = useMemo(() => {
    if (!fileContents || fileContents.forPath !== filePath || (fileContents.old == null && fileContents.new == null)) return fileDiff;
    const result = processFile(patch, {
      oldFile: fileContents.old != null ? { name: oldPath || filePath, contents: fileContents.old } : undefined,
      newFile: fileContents.new != null ? { name: filePath, contents: fileContents.new } : undefined,
    });
    return result || fileDiff;
  }, [patch, filePath, oldPath, fileContents, fileDiff]);

  // Clear pending selection when file changes
  const prevFilePathRef = useRef(filePath);
  useEffect(() => {
    if (prevFilePathRef.current !== filePath) {
      prevFilePathRef.current = filePath;
      onLineSelection(null);
    }
  }, [filePath, onLineSelection]);

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
  }, [selectedAnnotationId]);

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
  }, [searchQuery, searchMatches, filePath, diffStyle, diffOverflow, diffIndicators, lineDiffType, disableLineNumbers, disableBackground, augmentedDiff]);

  // Swap active search highlight instantly when stepping between matches.
  // This avoids a full rebuild just to change two elements' background color.
  useEffect(() => {
    if (!containerRef.current) return;
    swapActiveSearchHighlight(containerRef.current, activeSearchMatchId);
  }, [activeSearchMatchId]);

  // Scroll to active search match (with retry for lazy-rendered content)
  useEffect(() => {
    if (!activeSearchMatch || !containerRef.current) return;
    return retryScrollToSearchMatch(containerRef.current, activeSearchMatch);
  }, [activeSearchMatch, filePath, diffStyle, diffOverflow, diffIndicators, lineDiffType, disableLineNumbers, disableBackground]);

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

  // Render hover utility (+ button)
  const renderHoverUtility = useCallback((getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => {
    const line = getHoveredLine();
    if (!line) return null;

    return (
      <button
        className="hover-add-comment"
        onClick={(e) => {
          e.stopPropagation();
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

  // Inject resolved colors into @pierre/diffs shadow DOM.
  // CSS custom properties don't cross the shadow boundary, so we read computed
  // values and pass them via unsafeCSS. Single state object avoids split renders.
  const [pierreTheme, setPierreTheme] = useState<{ type: 'dark' | 'light'; css: string }>({ type: 'dark', css: '' });

  useEffect(() => {
    requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      const bg = styles.getPropertyValue('--background').trim();
      const fg = styles.getPropertyValue('--foreground').trim();
      const muted = styles.getPropertyValue('--muted').trim();
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
            grid-template-columns: var(--split-left, 1fr) var(--split-right, 1fr) !important;
          }
          ${fontCSS}
        `,
      });
    });
  }, [resolvedMode, colorTheme, fontFamily, fontSize]);

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

      <div ref={containerRef} className={`flex-1 overflow-auto relative ${isDraggingSplit ? 'select-none' : ''}`} onMouseMove={toolbar.handleMouseMove}>
      {isSplitLayout && diffOverflow !== 'wrap' && (
        <div
          className="absolute top-0 bottom-0 z-10 cursor-col-resize group"
          style={{ left: `${splitRatio * 100}%`, width: 9, marginLeft: -4 }}
          onPointerDown={handleSplitDragStart}
          onDoubleClick={resetSplitRatio}
        >
          <div className="absolute inset-y-0 left-1/2 w-px bg-border group-hover:bg-primary/50 group-active:bg-primary/70 transition-colors" />
        </div>
      )}
      <div
        className="p-4"
        style={isSplitLayout && diffOverflow !== 'wrap' ? {
          '--split-left': `${splitRatio}fr`,
          '--split-right': `${1 - splitRatio}fr`,
        } as React.CSSProperties : undefined}
      >
        <FileDiff
          key={filePath}
          fileDiff={augmentedDiff}
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
            onLineSelectionEnd: toolbar.handleLineSelectionEnd,
          }}
          lineAnnotations={mergedAnnotations}
          selectedLines={pendingSelection || undefined}
          renderAnnotation={renderAnnotation}
          renderHoverUtility={renderHoverUtility}
        />
      </div>

      {toolbar.toolbarState && (
        <AnnotationToolbar
          toolbarState={toolbar.toolbarState}
          toolbarRef={toolbar.toolbarRef}
          commentText={toolbar.commentText}
          setCommentText={toolbar.setCommentText}
          suggestedCode={toolbar.suggestedCode}
          setSuggestedCode={toolbar.setSuggestedCode}
          showSuggestedCode={toolbar.showSuggestedCode}
          setShowSuggestedCode={toolbar.setShowSuggestedCode}
          setShowCodeModal={toolbar.setShowCodeModal}
          isEditing={!!toolbar.editingAnnotationId}
          onSubmit={toolbar.handleSubmitAnnotation}
          onDismiss={toolbar.handleDismiss}
          onCancel={toolbar.handleCancel}
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
      </div>
    </div>
  );
};
