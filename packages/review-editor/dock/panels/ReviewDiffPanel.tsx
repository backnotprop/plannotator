import React, { useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { DiffViewer } from '../../components/DiffViewer';
import { useReviewState } from '../ReviewStateContext';
import { getReviewDiffPanelFilePath, type ReviewDiffPanelParams } from '../reviewPanelTypes';
import { annotationMatchesPrScope } from '../../utils/annotationScope';
import { fileKind } from '@plannotator/core/file-kind';
import { isLineRangeInPatch } from '@plannotator/core/diff-files';
import { FileViewSwitch } from '../../components/FileViewSwitch';
import { WholeFileView } from '../../components/WholeFileView';
import { JumpCrumb } from '../../components/JumpCrumb';

/**
 * Thin adapter between dockview's panel API and the existing DiffViewer.
 *
 * Receives `filePath` from dockview params, reads everything else from
 * the ReviewStateContext. The existing DiffViewer component is not modified.
 */
export const ReviewDiffPanel: React.FC<IDockviewPanelProps> = (props) => {
  const filePath =
    getReviewDiffPanelFilePath(props.params) ??
    getReviewDiffPanelFilePath(props.api.getParameters<ReviewDiffPanelParams>());
  return <ReviewDiffBody filePath={filePath} onKeep={undefined} />;
};

/**
 * One changed file: its diff, or (Changes | Whole file) the whole new side
 * with change bars. Drawn by the diff tab and by a file kept in its own tab.
 * `onKeep` keeps a preview tab when a comment is made in it.
 */
export const ReviewDiffBody: React.FC<{ filePath: string | null; onKeep?: () => void }> = ({ filePath, onKeep }) => {
  const state = useReviewState();
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
  // Comments outside the diff are drawn in the Whole file view only.
  const diffFileAnnotations = useMemo(
    () => (fileAnnotations.some((a) => a.outsideDiff) ? fileAnnotations.filter((a) => !a.outsideDiff) : fileAnnotations),
    [fileAnnotations],
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

  const reviewFilePaths = useMemo(
    () => new Set(state.files.map((candidate) => candidate.path)),
    [state.files]
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

  // Changes | Whole file: offered where the server reads whole files at the
  // new side, for a file that has one (not a deletion), and not for Markdown,
  // whose Read view already shows the whole document.
  const fileView = state.fileViewOf ? state.fileViewOf(file.path) : 'changes';
  const crumb = state.jumpCrumb?.targetPath === file.path ? state.jumpCrumb : null;
  const markdownFile = !!state.markdownPreview?.isPreviewable(file);
  const wholeUnavailableReason = file.status === 'deleted'
    ? 'The diff deletes this file'
    : null;
  const showSwitch = !!state.onFileViewChange && !markdownFile;
  const wholeView = showSwitch && fileView === 'whole' && !wholeUnavailableReason;
  const switchControl = showSwitch ? (
    <FileViewSwitch
      view={wholeView ? 'whole' : 'changes'}
      onSelect={(view) => state.onFileViewChange!(file.path, view)}
      wholeUnavailableReason={wholeUnavailableReason}
    />
  ) : undefined;

  // Keying on reviewBase forces a remount when the user picks a new base.
  // Otherwise the file-content fetch for the new base can land before the new
  // patch, and Pierre briefly reconciles old-patch + new-content → "trailing
  // context mismatch" warnings in the console.
  return (
    <div key={`${file.path}:${state.reviewBase ?? ''}:${state.activeDiffBase ?? ''}:${state.feedbackDiffContext?.snapshotId ?? ''}`} className="h-full flex flex-col">
      {crumb && <JumpCrumb crumb={crumb} onBack={state.navigation?.back} />}
      <div className="flex-1 min-h-0 relative">
      <DiffViewer
        headerAccessory={switchControl}
        bodyOverride={wholeView ? (
          <WholeFileView
            filePath={file.path}
            patch={file.patch}
            snapshotId={state.snapshotId}
            annotations={fileAnnotations}
            selectedAnnotationId={state.selectedAnnotationId}
            onAddAnnotation={state.onAddWholeFileAnnotation ? (input) => {
              onKeep?.();
              state.onAddWholeFileAnnotation!(input, {
                inDiff: isLineRangeInPatch(file.patch, input.lineStart, input.lineEnd, 'new'),
              });
            } : undefined}
            onEditAnnotation={(id, text) => state.onEditAnnotation(id, text)}
            onDeleteAnnotation={state.onDeleteAnnotation}
            onSelectAnnotation={state.onSelectAnnotation}
            revealTarget={state.revealTarget}
            tokens={state.fileTokens?.(file.path)}
          />
        ) : undefined}
        patch={file.patch}
        filePath={file.path}
        oldPath={file.oldPath}
        status={file.status}
        reviewBase={state.reviewBase}
        reviewSnapshotId={state.feedbackDiffContext?.snapshotId}
        imagePreviewAvailable={state.imagePreviewAvailable}
        imageSnapshotId={state.snapshotId}
        contextExpansionAvailable={state.contextExpansionAvailable}
        packageChangesAvailable={state.contextExpansionAvailable !== false}
        prUrl={state.prMetadata?.url}
        prDiffScope={state.prDiffScope}
        isFocused={isFocusedFile}
        changeNavigation={isFocusedFile && state.isDiffPanelActive === true}
        diffStyle={state.diffStyle}
        diffOverflow={state.diffOverflow}
        diffIndicators={state.diffIndicators}
        lineDiffType={state.lineDiffType}
        disableLineNumbers={state.disableLineNumbers}
        disableBackground={state.disableBackground}
        expandUnchanged={state.expandUnchanged}
        fontFamily={state.fontFamily}
        fontSize={state.fontSize}
        annotations={diffFileAnnotations}
        selectedAnnotationId={state.selectedAnnotationId}
        scrollTargetAnnotation={state.scrollTargetAnnotation}
        pendingSelection={state.pendingSelection}
        compactTouchLayout={state.isCompactTouchLayout}
        onLineSelection={state.onLineSelection}
        onAddAnnotation={state.onAddAnnotation}
        onAddFileComment={state.onAddFileComment}
        onEditAnnotation={state.onEditAnnotation}
        onSelectAnnotation={state.onSelectAnnotation}
        onDeleteAnnotation={state.onDeleteAnnotation}
        onExplainAnnotation={state.aiAvailable ? state.onExplainAnnotation : undefined}
        agentFindingSources={state.agentFindingSources}
        isViewed={state.viewedFiles.has(file.path)}
        isGenerated={state.generatedFiles.has(file.path)}
        isTest={fileKind(file.path, state.generatedFiles) === 'test'}
        onToggleViewed={() => state.onToggleViewed(file.path)}
        showViewedControls={state.showViewedControls}
        isStaged={state.stagedFiles.has(file.path)}
        isStaging={state.stagingFile === file.path}
        onStage={() => state.onStage(file.path)}
        // Per-path gate (falls back to the mode-level flag): in since-base the
        // single-file header lists committed files too — mode-level canStageFiles
        // alone would offer a no-op Git Add on them that flips local state.
        // Mirrors the `a` shortcut and the all-files header.
        canStage={state.canStagePath ? state.canStagePath(file.path) : state.canStageFiles}
        showStageControls={state.showStageControls}
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
        onTokenHoverEnter={state.onTokenHoverEnter}
        onTokenHoverLeave={state.onTokenHoverLeave}
        onTokenTarget={state.onTokenTarget}
        reviewFilePaths={reviewFilePaths}
        onOpenReviewFile={state.openDiffFile}
        markdownPreviewSupported={!!state.markdownPreview}
        markdownView={state.markdownPreview ? state.markdownPreview.viewOf(file.path) : 'source'}
        markdownViewDisabledReason={state.markdownPreview?.lockReason(file.path) ?? null}
        onMarkdownViewChange={state.markdownPreview
          ? (view, how) => (how === 'chosen' ? state.markdownPreview!.choose : state.markdownPreview!.show)(file.path, view)
          : undefined}
      />
      </div>
    </div>
  );
};
