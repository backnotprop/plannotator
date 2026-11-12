import React, { useCallback, useMemo } from 'react';
import { GuideHostProvider, type GuideDiffRendererContext, type GuideGlobalComments, type GuideHostValue } from '@plannotator/guide-viewer/host';
import { useReviewState } from '../../dock/ReviewStateContext';
import { AllFilesCodeView, type AllFilesCodeViewProps } from '../AllFilesCodeView';
import { storage } from '@plannotator/ui/utils/storage';
import { chapterDiagramRenderer, overviewDiagramRenderer } from './overviewDiagram';

type InAppRendererProps = Omit<
  AllFilesCodeViewProps,
  | 'files'
  | 'fileScrollTarget'
  | 'fileOrder'
  | 'mountCollapsed'
  | 'initialScrollPosition'
  | 'onScrollPositionChange'
  | 'onFileCollapsedChange'
  | 'isActive'
  | 'allowScrollChaining'
>;

export const ReviewGuideHost: React.FC<{
  children: React.ReactNode;
  globalComments?: GuideGlobalComments;
  collapseAll?: GuideHostValue['collapseAll'];
}> = ({ children, globalComments, collapseAll }) => {
  const state = useReviewState();

  const getDiffRendererProps = useCallback(
    ({ focused }: GuideDiffRendererContext): InAppRendererProps => ({
      diffStyle: state.diffStyle,
      diffOverflow: state.diffOverflow,
      diffIndicators: state.diffIndicators,
      lineDiffType: state.lineDiffType,
      disableLineNumbers: state.disableLineNumbers,
      disableBackground: state.disableBackground,
      expandUnchanged: state.expandUnchanged,
      fontFamily: state.fontFamily,
      fontSize: state.fontSize,
      annotations: state.allAnnotations,
      selectedAnnotationId: state.selectedAnnotationId,
      scrollTargetAnnotation: state.scrollTargetAnnotation,
      pendingSelection: focused ? state.pendingSelection : null,
      reviewBase: state.reviewBase,
      reviewSnapshotId: state.feedbackDiffContext?.snapshotId,
      onLineSelection: state.onLineSelection,
      onAddAnnotationForFile: state.onAddAnnotationForFile,
      onEditAnnotation: state.onEditAnnotation,
      onSelectAnnotation: state.onSelectAnnotation,
      onDeleteAnnotation: state.onDeleteAnnotation,
      onAddFileCommentForFile: state.onAddFileCommentForFile,
      viewedFiles: state.viewedFiles,
      onToggleViewed: state.onToggleViewed,
      showViewedControls: state.showViewedControls,
      stagedFiles: state.stagedFiles,
      onStage: state.onStage,
      canStageFiles: state.canStageFiles,
      showStageControls: state.showStageControls,
      canStagePath: state.canStagePath,
      stagingFile: state.stagingFile,
      stageError: state.stageError,
      prUrl: state.prMetadata?.url,
      prDiffScope: state.prDiffScope,
      searchQuery: state.isSearchPending ? '' : state.debouncedSearchQuery,
      searchMatches: state.searchMatches,
      activeSearchMatchId: state.activeSearchMatchId,
      activeSearchMatch: state.allFilesActiveSearchMatch,
      onCodeNavRequest: state.onCodeNavRequest,
      aiAvailable: state.aiAvailable,
      onAskAIForFile: state.onAskAIForFile,
      isAILoading: state.isAILoading,
      onViewAIResponse: state.onViewAIResponse,
      aiMessages: state.aiMessages,
      onClickAIMarker: state.onClickAIMarker,
      getAIHistoryForFile: state.getAIHistoryForFile,
    }),
    [state],
  );

  const renderOverviewDiagram = useMemo(() => overviewDiagramRenderer(state.diagramEngine), [state.diagramEngine]);
  const renderChapterDiagram = useMemo(() => chapterDiagramRenderer(state.diagramEngine), [state.diagramEngine]);

  const value = useMemo<GuideHostValue<InAppRendererProps>>(
    () => ({
      files: state.files,
      DiffRenderer: AllFilesCodeView,
      getDiffRendererProps,
      revealFile: state.guideRevealFile,
      onRevealFile: state.onGuideRevealFile,
      activeSearchMatch: state.allFilesActiveSearchMatch,
      generatedFiles: state.generatedFiles,
      renderOverviewDiagram,
      renderChapterDiagram,
      diagramFoldStore: storage,
      ...(globalComments ? { globalComments } : {}),
      ...(collapseAll ? { collapseAll } : {}),
    }),
    [state.files, getDiffRendererProps, state.guideRevealFile, state.onGuideRevealFile, state.allFilesActiveSearchMatch, state.generatedFiles, renderOverviewDiagram, renderChapterDiagram, globalComments, collapseAll],
  );

  return <GuideHostProvider value={value}>{children}</GuideHostProvider>;
};
