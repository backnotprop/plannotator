import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, DiffAnnotationMetadata } from '@plannotator/ui/types';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';

interface DiffViewerProps {
  patch: string;
  filePath: string;
  diffStyle: 'split' | 'unified';
  annotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string) => void;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
  isViewed?: boolean;
  onToggleViewed?: () => void;
}

interface ToolbarState {
  position: { top: number; left: number };
  range: SelectedLineRange;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  patch,
  filePath,
  diffStyle,
  annotations,
  selectedAnnotationId,
  pendingSelection,
  onLineSelection,
  onAddAnnotation,
  onSelectAnnotation,
  onDeleteAnnotation,
  isViewed = false,
  onToggleViewed,
}) => {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [commentText, setCommentText] = useState('');
  const [suggestedCode, setSuggestedCode] = useState('');
  const [showSuggestedCode, setShowSuggestedCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastMousePosition = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Track mouse position continuously for toolbar placement
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    lastMousePosition.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Clear pending selection when file changes
  const prevFilePathRef = useRef(filePath);
  useEffect(() => {
    if (prevFilePathRef.current !== filePath) {
      prevFilePathRef.current = filePath;
      onLineSelection(null); // Clear selection when switching files
    }
  }, [filePath, onLineSelection]);

  // Scroll to selected annotation when it changes
  useEffect(() => {
    if (!selectedAnnotationId || !containerRef.current) return;

    // Small delay to allow render after file switch
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

  // Map annotations to @pierre/diffs format
  // Place annotation under the last line of the range (GitHub-style)
  const lineAnnotations = useMemo(() => {
    return annotations.map(ann => ({
      side: ann.side === 'new' ? 'additions' : 'deletions' as const,
      lineNumber: ann.lineEnd,
      metadata: {
        annotationId: ann.id,
        type: ann.type,
        text: ann.text,
        suggestedCode: ann.suggestedCode,
        author: ann.author,
      } as DiffAnnotationMetadata,
    }));
  }, [annotations]);

  // Handle line selection end
  const handleLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    if (!range || !containerRef.current) {
      setToolbarState(null);
      onLineSelection(null);
      return;
    }

    // Position toolbar near where user clicked/released
    const mousePos = lastMousePosition.current;

    setToolbarState({
      position: {
        top: mousePos.y + 10, // Just below the click
        left: mousePos.x,
      },
      range,
    });
    onLineSelection(range);
  }, [onLineSelection]);

  // Handle annotation submission
  const handleSubmitAnnotation = useCallback(() => {
    if (!toolbarState || !commentText.trim()) return;

    onAddAnnotation(
      'comment',
      commentText,
      suggestedCode.trim() || undefined
    );

    // Reset state
    setToolbarState(null);
    setCommentText('');
    setSuggestedCode('');
    setShowSuggestedCode(false);
  }, [toolbarState, commentText, suggestedCode, onAddAnnotation]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    setToolbarState(null);
    setCommentText('');
    setSuggestedCode('');
    setShowSuggestedCode(false);
    onLineSelection(null);
  }, [onLineSelection]);

  // Render annotation in diff - returns React element
  const renderAnnotation = useCallback((annotation: { side: string; lineNumber: number; metadata?: DiffAnnotationMetadata }) => {
    if (!annotation.metadata) return null;

    const meta = annotation.metadata;

    return (
      <div
        className="review-comment"
        data-annotation-id={meta.annotationId}
        onClick={() => onSelectAnnotation(meta.annotationId)}
      >
        <div className="review-comment-header">
          {meta.author && <span className="text-xs text-muted-foreground">{meta.author}</span>}
          <button
            className="review-comment-delete"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteAnnotation(meta.annotationId);
            }}
            title="Delete"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {meta.text && (
          <div className="review-comment-body">{meta.text}</div>
        )}
        {meta.suggestedCode && (
          <div className="mt-2">
            <div className="text-[10px] text-muted-foreground mb-1">Suggested:</div>
            <pre className="export-code-block text-xs">{meta.suggestedCode}</pre>
          </div>
        )}
      </div>
    );
  }, [onSelectAnnotation, onDeleteAnnotation]);

  // Render hover utility (+ button) - returns React element
  const renderHoverUtility = useCallback((getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => {
    const line = getHoveredLine();
    if (!line) return null;

    return (
      <button
        className="hover-add-comment"
        onClick={(e) => {
          e.stopPropagation();
          handleLineSelectionEnd({
            start: line.lineNumber,
            end: line.lineNumber,
            side: line.side,
          });
        }}
      >
        +
      </button>
    );
  }, [handleLineSelectionEnd]);

  // Determine theme for @pierre/diffs
  const pierreTheme = useMemo(() => {
    const effectiveTheme = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme;
    return effectiveTheme === 'light' ? 'pierre-light' : 'pierre-dark';
  }, [theme]);

  return (
    <div ref={containerRef} className="h-full overflow-auto relative" onMouseMove={handleMouseMove}>
      {/* File header */}
      <div className="sticky top-0 z-10 px-4 py-2 bg-card/95 backdrop-blur border-b border-border flex items-center justify-between">
        <span className="font-mono text-sm text-foreground">{filePath}</span>
        <div className="flex items-center gap-2">
          {onToggleViewed && (
            <button
              onClick={onToggleViewed}
              className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
                isViewed
                  ? 'bg-success/15 text-success'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              title={isViewed ? "Mark as not viewed" : "Mark as viewed"}
            >
              {isViewed ? (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
              Viewed
            </button>
          )}
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(patch);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch (err) {
                console.error('Failed to copy:', err);
              }
            }}
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors flex items-center gap-1"
            title="Copy this file's diff"
          >
            {copied ? (
              <>
                <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copy Diff
              </>
            )}
          </button>
        </div>
      </div>

      {/* Diff content */}
      <div className="p-4">
        <PatchDiff
          key={filePath} // Force remount on file change to reset internal state
          patch={patch}
          options={{
            theme: pierreTheme,
            themeType: 'dark',
            diffStyle,
            diffIndicators: 'bars',
            enableLineSelection: true,
            enableHoverUtility: true,
            onLineSelectionEnd: handleLineSelectionEnd,
          }}
          lineAnnotations={lineAnnotations}
          selectedLines={pendingSelection || undefined}
          renderAnnotation={renderAnnotation}
          renderHoverUtility={renderHoverUtility}
        />
      </div>

      {/* Annotation toolbar - single-step comment input */}
      {toolbarState && (
        <div
          className="review-toolbar"
          style={{
            position: 'fixed',
            top: Math.min(toolbarState.position.top, window.innerHeight - 200),
            left: Math.max(150, Math.min(toolbarState.position.left, window.innerWidth - 150)),
            transform: 'translateX(-50%)',
            zIndex: 1000,
          }}
        >
          <div className="w-80">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">
                {toolbarState.range.start === toolbarState.range.end
                  ? `Line ${toolbarState.range.start}`
                  : `Lines ${Math.min(toolbarState.range.start, toolbarState.range.end)}-${Math.max(toolbarState.range.start, toolbarState.range.end)}`}
              </span>
              <button
                onClick={handleCancel}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Cancel"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Leave feedback..."
              className="w-full px-3 py-2 bg-muted rounded-lg text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
              rows={3}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  handleCancel();
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  handleSubmitAnnotation();
                }
              }}
            />

            {/* Optional suggested code section */}
            {showSuggestedCode ? (
              <textarea
                value={suggestedCode}
                onChange={(e) => setSuggestedCode(e.target.value)}
                placeholder="Suggested code..."
                className="w-full px-3 py-2 mt-2 bg-muted rounded-lg text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
                rows={3}
                autoFocus
              />
            ) : (
              <button
                onClick={() => setShowSuggestedCode(true)}
                className="mt-2 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Add suggested code
              </button>
            )}

            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={handleSubmitAnnotation}
                disabled={!commentText.trim()}
                className="review-toolbar-btn primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add Comment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
