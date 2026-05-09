import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { AllFilesDiffView } from '../../components/AllFilesDiffView';
import { useReviewState } from '../ReviewStateContext';

export const ReviewAllFilesDiffPanel: React.FC<IDockviewPanelProps> = () => {
  const state = useReviewState();

  return (
    <AllFilesDiffView
      files={state.files}
      annotations={state.allAnnotations}
      selectedAnnotationId={state.selectedAnnotationId}
      pendingSelection={state.pendingSelection}
      onLineSelection={state.onLineSelection}
      onAddAnnotation={state.onAddAnnotationForFile}
      onAddFileComment={state.onAddFileCommentForFile}
      onEditAnnotation={state.onEditAnnotation}
      onSelectAnnotation={state.onSelectAnnotation}
      onDeleteAnnotation={state.onDeleteAnnotation}
      diffStyle={state.diffStyle}
      diffOverflow={state.diffOverflow}
      diffIndicators={state.diffIndicators}
      lineDiffType={state.lineDiffType}
      disableLineNumbers={state.disableLineNumbers}
      disableBackground={state.disableBackground}
      fontFamily={state.fontFamily}
      fontSize={state.fontSize}
      viewedFiles={state.viewedFiles}
      onToggleViewed={state.onToggleViewed}
      stagedFiles={state.stagedFiles}
      onStage={state.onStage}
      canStageFiles={state.canStageFiles}
      stagingFile={state.stagingFile}
      stageError={state.stageError}
      reviewBase={state.reviewBase}
      prUrl={state.prMetadata?.url}
      prDiffScope={state.prDiffScope}
      onVisibleFileChange={state.onAllFilesVisibleFileChange}
      isActive={state.isAllFilesActive}
    />
  );
};
