import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { AllFilesCodeView } from '../../components/AllFilesCodeView';
import { useReviewState } from '../ReviewStateContext';

export const ReviewAllFilesDiffPanel: React.FC<IDockviewPanelProps> = () => {
  const state = useReviewState();

  return (
    <AllFilesCodeView
      files={state.files}
      diffStyle={state.diffStyle}
      diffOverflow={state.diffOverflow}
      diffIndicators={state.diffIndicators}
      lineDiffType={state.lineDiffType}
      disableLineNumbers={state.disableLineNumbers}
      disableBackground={state.disableBackground}
      expandUnchanged={state.expandUnchanged}
      fontFamily={state.fontFamily}
      fontSize={state.fontSize}
      annotations={state.allAnnotations}
      selectedAnnotationId={state.selectedAnnotationId}
      pendingSelection={state.pendingSelection}
      reviewBase={state.reviewBase}
      onLineSelection={state.onLineSelection}
      onAddAnnotationForFile={state.onAddAnnotationForFile}
      onEditAnnotation={state.onEditAnnotation}
      onSelectAnnotation={state.onSelectAnnotation}
      onDeleteAnnotation={state.onDeleteAnnotation}
      onAddFileCommentForFile={state.onAddFileCommentForFile}
      viewedFiles={state.viewedFiles}
      onToggleViewed={state.onToggleViewed}
      stagedFiles={state.stagedFiles}
      onStage={state.onStage}
      canStageFiles={state.canStageFiles}
      stagingFile={state.stagingFile}
      stageError={state.stageError}
      prUrl={state.prMetadata?.url}
      prDiffScope={state.prDiffScope}
      searchQuery={state.searchQuery}
      searchMatches={state.searchMatches}
      activeSearchMatchId={state.activeSearchMatchId}
      activeSearchMatch={state.allFilesActiveSearchMatch}
      onCodeNavRequest={state.onCodeNavRequest}
      onVisibleFileChange={state.onAllFilesVisibleFileChange}
      isActive={state.isAllFilesActive}
      aiAvailable={state.aiAvailable}
      onAskAI={state.onAskAI}
      isAILoading={state.isAILoading}
      onViewAIResponse={state.onViewAIResponse}
      aiHistoryForSelection={state.aiHistoryForSelection}
    />
  );
};
