import React, { useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { DiffViewer } from '../../components/DiffViewer';
import { useReviewState } from '../ReviewStateContext';
import { getReviewDiffPanelFilePath, type ReviewDiffPanelParams } from '../reviewPanelTypes';
import { annotationMatchesPrScope } from '../../utils/annotationScope';

/**
 * Thin adapter between dockview's panel API and the existing DiffViewer.
 *
 * Receives `filePath` from dockview params, reads everything else from
 * the ReviewStateContext. The existing DiffViewer component is not modified.
 */
export const ReviewDiffPanel: React.FC<IDockviewPanelProps> = (props) => {
  const state = useReviewState();
  const filePath =
    getReviewDiffPanelFilePath(props.params) ??
    getReviewDiffPanelFilePath(props.api.getParameters<ReviewDiffPanelParams>());
  const file = filePath
    ? state.files.find(candidate => candidate.path === filePath)
    : undefined;
  const isFocusedFile = !!file && state.focusedFilePath === file.path;

  const fileAnnotations = useMemo(
    () => {
      if (!file) return [];
      const currentPrUrl = state.prMetadata?.url;
      const currentDiffScope = state.prDiffScope;
      return state.allAnnotations.filter((a) =>
        a.filePath === file.path &&
        annotationMatchesPrScope(a, currentPrUrl, currentDiffScope)
      );
    },
    [state.allAnnotations, file, state.prMetadata, state.prDiffScope]
  );

  const aiMessagesForFile = useMemo(
    () =>
      file
        ? state.aiMessages.filter(
            (m) => m.question.filePath === file.path
          )
        : [],
    [state.aiMessages, file]
  );

  const searchMatchesForFile = useMemo(
    () =>
      file && isFocusedFile
        ? state.activeFileSearchMatches
        : [],
    [state.activeFileSearchMatches, isFocusedFile, file]
  );

  if (!file) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        File not found
      </div>
    );
  }

  // Keying on reviewBase forces a remount when the user picks a new base.
  // Otherwise the file-content fetch for the new base can land before the new
  // patch, and Pierre briefly reconciles old-patch + new-content → "trailing
  // context mismatch" warnings in the console.
  return (
    <div key={`${file.path}:${state.reviewBase ?? ''}:${state.activeDiffBase ?? ''}:${state.feedbackDiffContext?.snapshotId ?? ''}`} className="h-full relative">
      <DiffViewer
        patch={file.patch}
        filePath={file.path}
        oldPath={file.oldPath}
        status={file.status}
        reviewBase={state.reviewBase}
        reviewSnapshotId={state.feedbackDiffContext?.snapshotId}
        prUrl={state.prMetadata?.url}
        prDiffScope={state.prDiffScope}
        isFocused={isFocusedFile}
        diffStyle={state.diffStyle}
        diffOverflow={state.diffOverflow}
        diffIndicators={state.diffIndicators}
        lineDiffType={state.lineDiffType}
        disableLineNumbers={state.disableLineNumbers}
        disableBackground={state.disableBackground}
        expandUnchanged={state.expandUnchanged}
        fontFamily={state.fontFamily}
        fontSize={state.fontSize}
        annotations={fileAnnotations}
        selectedAnnotationId={state.selectedAnnotationId}
        scrollTargetAnnotation={state.scrollTargetAnnotation}
        pendingSelection={state.pendingSelection}
        onLineSelection={state.onLineSelection}
        onAddAnnotation={state.onAddAnnotation}
        onAddFileComment={state.onAddFileComment}
        onEditAnnotation={state.onEditAnnotation}
        onSelectAnnotation={state.onSelectAnnotation}
        onDeleteAnnotation={state.onDeleteAnnotation}
        isViewed={state.viewedFiles.has(file.path)}
        onToggleViewed={() => state.onToggleViewed(file.path)}
        isStaged={state.stagedFiles.has(file.path)}
        isStaging={state.stagingFile === file.path}
        onStage={() => state.onStage(file.path)}
        // Per-path gate (falls back to the mode-level flag): in since-base the
        // single-file header lists committed files too — mode-level canStageFiles
        // alone would offer a no-op Git Add on them that flips local state.
        // Mirrors the `a` shortcut and the all-files header.
        canStage={state.canStagePath ? state.canStagePath(file.path) : state.canStageFiles}
        stageError={state.stageError}
        searchQuery={state.isSearchPending ? '' : state.debouncedSearchQuery}
        searchMatches={searchMatchesForFile}
        activeSearchMatchId={isFocusedFile ? state.activeSearchMatchId : null}
        activeSearchMatch={
          isFocusedFile && state.activeSearchMatch?.filePath === file.path
            ? state.activeSearchMatch
            : null
        }
        aiAvailable={state.aiAvailable}
        onAskAI={state.onAskAI}
        isAILoading={state.isAILoading}
        onViewAIResponse={state.onViewAIResponse}
        aiMessages={aiMessagesForFile}
        onClickAIMarker={state.onClickAIMarker}
        aiHistoryMessages={isFocusedFile ? state.aiHistoryForSelection : []}
        onCodeNavRequest={state.onCodeNavRequest}
      />
    </div>
  );
};
