import React, { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import { FileDiff } from '@pierre/diffs/react';
import { getSingularPatch, processFile } from '@pierre/diffs';
import { CodeAnnotation, CodeAnnotationType, SelectedLineRange, DiffAnnotationMetadata } from '@plannotator/ui/types';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { detectLanguage } from '../utils/detectLanguage';
import { useAnnotationToolbar } from '../hooks/useAnnotationToolbar';
import { FileHeader } from './FileHeader';
import { InlineAnnotation } from './InlineAnnotation';
import { AnnotationToolbar } from './AnnotationToolbar';
import { SuggestionModal } from './SuggestionModal';

interface DiffViewerProps {
  patch: string;
  filePath: string;
  oldPath?: string;
  diffStyle: 'split' | 'unified';
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
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  patch,
  filePath,
  oldPath,
  diffStyle,
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
}) => {
  const { theme, colorTheme, resolvedMode } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [fileCommentAnchor, setFileCommentAnchor] = useState<HTMLElement | null>(null);

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
        `,
      });
    });
  }, [resolvedMode, colorTheme]);

  return (
    <div ref={containerRef} className="h-full overflow-auto relative" onMouseMove={toolbar.handleMouseMove}>
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

      <div className="p-4">
        <FileDiff
          key={filePath}
          fileDiff={augmentedDiff}
          options={{
            themeType: pierreTheme.type,
            unsafeCSS: pierreTheme.css,
            diffStyle,
            diffIndicators: 'bars',
            hunkSeparators: 'line-info',
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
  );
};
