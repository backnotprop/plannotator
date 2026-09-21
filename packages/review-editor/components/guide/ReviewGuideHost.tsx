import React, { useCallback, useMemo } from 'react';
import { GuideHostProvider, type GuideDiffRendererContext, type GuideHostValue } from '@plannotator/guide-viewer/host';
import { useReviewState } from '../../dock/ReviewStateContext';
import { AllFilesCodeView, type AllFilesCodeViewProps } from '../AllFilesCodeView';

/**
 * The review app's guide host: adapts ReviewState into the narrow contract the
 * packaged guide chain consumes (`@plannotator/guide-viewer/host`), and names
 * `AllFilesCodeView` as the diff renderer with the full in-app wiring
 * (annotations, staging, viewed, search, AI markers).
 *
 * This is the only place review state reaches the guide chain. The portable
 * viewer provides the same contract with a read-only renderer, so both hosts
 * render byte-identical guides (decision record D2).
 */
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

export const ReviewGuideHost: React.FC<{ children: React.ReactNode }> = ({ children }) => {
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
      // Only the focused card is the selection target; a shared pending
      // selection painted on every mounted card would highlight the wrong file.
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

  const value = useMemo<GuideHostValue<InAppRendererProps>>(
    () => ({
      files: state.files,
      DiffRenderer: AllFilesCodeView,
      getDiffRendererProps,
      revealFile: state.guideRevealFile,
      onRevealFile: state.onGuideRevealFile,
      activeSearchMatch: state.allFilesActiveSearchMatch,
    }),
    [state.files, getDiffRendererProps, state.guideRevealFile, state.onGuideRevealFile, state.allFilesActiveSearchMatch],
  );

  return <GuideHostProvider value={value}>{children}</GuideHostProvider>;
};
