import React, { useMemo, useRef, useEffect, useCallback } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, DiffAnnotationMetadata } from '@plannotator/ui/types';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { detectLanguage } from '../utils/detectLanguage';
import { useAnnotationToolbar } from '../hooks/useAnnotationToolbar';
import { FileHeader } from './FileHeader';
import { InlineAnnotation } from './InlineAnnotation';
import { AnnotationToolbar } from './AnnotationToolbar';
import { SuggestionModal } from './SuggestionModal';

interface DiffViewerProps {
  patch: string;
  filePath: string;
  diffStyle: 'split' | 'unified';
  annotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (type: CodeAnnotationType, text?: string, suggestedCode?: string, originalCode?: string) => void;
  onEditAnnotation: (id: string, text?: string, suggestedCode?: string, originalCode?: string) => void;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
  isViewed?: boolean;
  onToggleViewed?: () => void;
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
  onEditAnnotation,
  onSelectAnnotation,
  onDeleteAnnotation,
  isViewed = false,
  onToggleViewed,
}) => {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);

  const toolbar = useAnnotationToolbar({ patch, filePath, onLineSelection, onAddAnnotation, onEditAnnotation });

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

  // Map annotations to @pierre/diffs format
  const lineAnnotations = useMemo(() => {
    return annotations.map(ann => ({
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

  // Handle edit: find annotation and start editing in toolbar
  const handleEdit = useCallback((id: string) => {
    const ann = annotations.find(a => a.id === id);
    if (ann) toolbar.startEdit(ann);
  }, [annotations, toolbar.startEdit]);

  // Render annotation in diff
  const renderAnnotation = useCallback((annotation: { side: string; lineNumber: number; metadata?: DiffAnnotationMetadata }) => {
    if (!annotation.metadata) return null;

    return (
      <InlineAnnotation
        metadata={annotation.metadata}
        language={detectLanguage(filePath)}
        onSelect={onSelectAnnotation}
        onEdit={handleEdit}
        onDelete={onDeleteAnnotation}
      />
    );
  }, [filePath, onSelectAnnotation, handleEdit, onDeleteAnnotation]);

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

  // Determine theme for @pierre/diffs
  const pierreTheme = useMemo(() => {
    const effectiveTheme = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme;
    return effectiveTheme === 'light' ? 'pierre-light' : 'pierre-dark';
  }, [theme]);

  return (
    <div ref={containerRef} className="h-full overflow-auto relative" onMouseMove={toolbar.handleMouseMove}>
      <FileHeader
        filePath={filePath}
        patch={patch}
        isViewed={isViewed}
        onToggleViewed={onToggleViewed}
      />

      <div className="p-4">
        <PatchDiff
          key={filePath}
          patch={patch}
          options={{
            theme: pierreTheme,
            themeType: 'dark',
            diffStyle,
            diffIndicators: 'bars',
            enableLineSelection: true,
            enableHoverUtility: true,
            onLineSelectionEnd: toolbar.handleLineSelectionEnd,
          }}
          lineAnnotations={lineAnnotations}
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
    </div>
  );
};
