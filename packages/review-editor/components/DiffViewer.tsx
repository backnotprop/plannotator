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
}

interface ToolbarState {
  position: { top: number; left: number };
  range: SelectedLineRange;
  step: 'menu' | 'input';
  type?: CodeAnnotationType;
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
}) => {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [commentText, setCommentText] = useState('');
  const [suggestedCode, setSuggestedCode] = useState('');
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
      step: 'menu',
    });
    onLineSelection(range);
  }, [onLineSelection]);

  // Handle toolbar menu selection
  const handleMenuSelect = useCallback((type: CodeAnnotationType) => {
    if (!toolbarState) return;

    if (type === 'comment') {
      setToolbarState({ ...toolbarState, step: 'input', type });
    } else {
      // For suggestion/concern, also show input
      setToolbarState({ ...toolbarState, step: 'input', type });
    }
  }, [toolbarState]);

  // Handle annotation submission
  const handleSubmitAnnotation = useCallback(() => {
    if (!toolbarState?.type) return;

    onAddAnnotation(
      toolbarState.type,
      commentText || undefined,
      toolbarState.type === 'suggestion' ? suggestedCode || undefined : undefined
    );

    // Reset state
    setToolbarState(null);
    setCommentText('');
    setSuggestedCode('');
  }, [toolbarState, commentText, suggestedCode, onAddAnnotation]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    setToolbarState(null);
    setCommentText('');
    setSuggestedCode('');
    onLineSelection(null);
  }, [onLineSelection]);

  // Render annotation in diff - returns React element
  const renderAnnotation = useCallback((annotation: { side: string; lineNumber: number; metadata?: DiffAnnotationMetadata }) => {
    if (!annotation.metadata) return null;

    const meta = annotation.metadata;

    return (
      <div
        className={`review-comment ${meta.type}`}
        data-annotation-id={meta.annotationId}
        onClick={() => onSelectAnnotation(meta.annotationId)}
      >
        <div className="review-comment-header">
          <span className={`annotation-badge ${meta.type}`}>
            {meta.type}
          </span>
          {meta.author && <span>{meta.author}</span>}
          <button
            className="review-comment-delete"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteAnnotation(meta.annotationId);
            }}
            title="Delete annotation"
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
          <pre className="export-code-block mt-2 text-xs">{meta.suggestedCode}</pre>
        )}
      </div>
    );
  }, [onSelectAnnotation, onDeleteAnnotation]);

  // Store hovered line for the hover utility
  const [hoveredLine, setHoveredLine] = useState<{ lineNumber: number; side: 'deletions' | 'additions' } | null>(null);

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

      {/* Annotation toolbar */}
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
          {toolbarState.step === 'menu' ? (
            <div className="flex gap-1">
              <button
                onClick={() => handleMenuSelect('comment')}
                className="review-toolbar-btn"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                Comment
              </button>
              <button
                onClick={() => handleMenuSelect('suggestion')}
                className="review-toolbar-btn"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                Suggestion
              </button>
              <button
                onClick={() => handleMenuSelect('concern')}
                className="review-toolbar-btn"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Concern
              </button>
              <div className="w-px h-5 bg-border/50 mx-1" />
              <button
                onClick={handleCancel}
                className="review-toolbar-btn text-muted-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="w-72">
              <div className="flex items-center gap-2 mb-2">
                <span className={`annotation-badge ${toolbarState.type}`}>
                  {toolbarState.type}
                </span>
                <span className="text-xs text-muted-foreground">
                  {toolbarState.range.start === toolbarState.range.end
                    ? `Line ${toolbarState.range.start}`
                    : `Lines ${toolbarState.range.start}-${toolbarState.range.end}`}
                </span>
              </div>

              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder={toolbarState.type === 'suggestion' ? 'Explain your suggestion...' : 'Add a comment...'}
                className="w-full px-3 py-2 bg-muted rounded-lg text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
                rows={3}
                autoFocus
              />

              {toolbarState.type === 'suggestion' && (
                <textarea
                  value={suggestedCode}
                  onChange={(e) => setSuggestedCode(e.target.value)}
                  placeholder="Suggested code replacement..."
                  className="w-full px-3 py-2 mt-2 bg-muted rounded-lg text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
                  rows={3}
                />
              )}

              <div className="flex justify-end gap-2 mt-2">
                <button
                  onClick={handleCancel}
                  className="review-toolbar-btn text-muted-foreground"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmitAnnotation}
                  disabled={!commentText.trim()}
                  className="review-toolbar-btn primary disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
