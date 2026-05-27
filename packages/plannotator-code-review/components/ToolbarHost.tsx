import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo } from 'react';
import type {
  CodeAnnotation,
  CodeAnnotationType,
  ConventionalDecoration,
  ConventionalLabel,
  SelectedLineRange,
  TokenAnnotationMeta,
} from '@plannotator/ui/types';
import type { DiffTokenEventBaseProps } from '@pierre/diffs';
import { useConfigValue } from '@plannotator/ui/config';
import { useAnnotationToolbar } from '../hooks/useAnnotationToolbar';
import { AnnotationToolbar } from './AnnotationToolbar';
import { SuggestionModal } from './SuggestionModal';
import { getEnabledLabels } from './ConventionalLabelPicker';
import type { AIChatEntry } from '../hooks/useAIChat';

export interface ToolbarHostHandle {
  handleLineSelectionEnd: (range: SelectedLineRange | null) => void;
  handleTokenClick: (props: DiffTokenEventBaseProps, event: MouseEvent) => void;
  startEdit: (annotation: CodeAnnotation) => void;
}

interface ToolbarHostProps {
  patch: string;
  filePath: string;
  isFocused: boolean;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotation: (
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
  // AI props (optional — only DiffViewer wires these today)
  aiAvailable?: boolean;
  onAskAI?: (question: string) => void;
  isAILoading?: boolean;
  onViewAIResponse?: (questionId?: string) => void;
  aiHistoryMessages?: AIChatEntry[];
}

/**
 * Owns `useAnnotationToolbar` so per-keystroke state changes don't re-render
 * the parent diff list. Parents talk to it through the imperative handle.
 */
export const ToolbarHost = forwardRef<ToolbarHostHandle, ToolbarHostProps>(function ToolbarHost(
  {
    patch,
    filePath,
    isFocused,
    onLineSelection,
    onAddAnnotation,
    onEditAnnotation,
    aiAvailable,
    onAskAI,
    isAILoading,
    onViewAIResponse,
    aiHistoryMessages,
  },
  ref,
) {
  const toolbar = useAnnotationToolbar({
    patch,
    filePath,
    isFocused,
    onLineSelection,
    onAddAnnotation,
    onEditAnnotation,
  });

  const conventionalCommentsEnabled = useConfigValue('conventionalComments');
  const conventionalLabelsJson = useConfigValue('conventionalLabels');
  const enabledLabels = useMemo(() => getEnabledLabels(conventionalLabelsJson), [conventionalLabelsJson]);

  // Replaces the parent's `onMouseMove={toolbar.handleMouseMove}` on its scroll
  // container — the hook only stashes clientX/Y for toolbar placement, so a
  // window-level listener is functionally equivalent for that purpose.
  const handleMouseMove = toolbar.handleMouseMove;
  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [handleMouseMove]);

  useImperativeHandle(
    ref,
    () => ({
      handleLineSelectionEnd: toolbar.handleLineSelectionEnd,
      handleTokenClick: toolbar.handleTokenClick,
      startEdit: toolbar.startEdit,
    }),
    [toolbar.handleLineSelectionEnd, toolbar.handleTokenClick, toolbar.startEdit],
  );

  const handleCloseCodeModal = useCallback(() => toolbar.setShowCodeModal(false), [toolbar.setShowCodeModal]);

  return (
    <>
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
          onClose={handleCloseCodeModal}
        />
      )}
    </>
  );
});
