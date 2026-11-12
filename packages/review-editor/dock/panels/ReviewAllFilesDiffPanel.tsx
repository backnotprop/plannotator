import React, { useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import { MarkdownPreviewFailed } from '../../components/DiffViewer';
import { AllFilesCodeView } from '../../components/AllFilesCodeView';
import { CommitDescriptionHeader } from '../../components/CommitDescriptionHeader';
import { ImageDiffPreview } from '../../components/ImageDiffPreview';
import { MarkdownViewMenu } from '../../components/MarkdownViewMenu';
import { PackageChangesCard } from '../../components/PackageChangesCard';
const MarkdownFilePreview = React.lazy(async () => ({ default: (await import('../../components/MarkdownFilePreview')).MarkdownFilePreview }));
import type { DiffFile } from '../../types';
import { useReviewState, useReviewStateOptional } from '../ReviewStateContext';

/**
 * Pierre's header slot republishes only on updateItem, but a context consumer inside it still
 * re-renders, so Changes <-> Read updates the label without touching the item.
 */
function ReviewMarkdownViewControl({ file, iconOnly, touch }: { file: DiffFile; iconOnly: boolean; touch: boolean }) {
  const preview = useReviewStateOptional()?.markdownPreview;
  if (!preview) return null;
  return (
    <MarkdownViewMenu
      filePath={file.path}
      view={preview.viewOf(file.path)}
      views={preview.viewsFor(file)}
      status={file.status}
      onChoose={(view) => preview.choose(file.path, view)}
      iconOnly={iconOnly}
      touch={touch}
      disabledReason={preview.lockReason(file.path)}
    />
  );
}

export const ReviewAllFilesDiffPanel: React.FC<IDockviewPanelProps> = () => {
  const state = useReviewState();
  const diffOnlyAnnotations = useMemo(
    () => (state.allAnnotations.some((a) => a.outsideDiff) ? state.allAnnotations.filter((a) => !a.outsideDiff) : state.allAnnotations),
    [state.allAnnotations],
  );

  const commitInfo = state.commitInfo;
  const snapshotId = state.snapshotId;
  const compact = state.isCompactTouchLayout;
  const renderImagePreview = useMemo(
    () =>
      state.imagePreviewAvailable
        ? ({ file, fallback, tooLargeFallback, onHeightChange }: Parameters<NonNullable<React.ComponentProps<typeof AllFilesCodeView>['renderImagePreview']>>[0]) => (
            <ImageDiffPreview
              key={`${snapshotId ?? ''}:${file.path}`}
              filePath={file.path}
              status={file.status}
              snapshotId={snapshotId}
              variant="all-files"
              compact={compact}
              fallback={fallback}
              tooLargeFallback={tooLargeFallback}
              onHeightChange={onHeightChange}
            />
          )
        : undefined,
    [state.imagePreviewAvailable, snapshotId, compact],
  );

  const packageReviewBase = state.reviewBase;
  const renderPackageChanges = useMemo(
    () =>
      state.contextExpansionAvailable !== false
        ? ({ file, onHeightChange }: { file: DiffFile; onHeightChange: () => void }) => (
            <PackageChangesCard
              key={`${snapshotId ?? ''}:${file.path}`}
              filePath={file.path}
              reviewBase={packageReviewBase}
              reviewSnapshotId={snapshotId}
              onHeightChange={onHeightChange}
              compactTouchLayout={compact}
            />
          )
        : undefined,
    [state.contextExpansionAvailable, packageReviewBase, snapshotId, compact],
  );

  const preview = state.markdownPreview;
  const reviewBase = state.reviewBase;
  const reviewSnapshotId = state.feedbackDiffContext?.snapshotId;
  const imagesAvailable = state.imagePreviewAvailable === true;
  const markdownPreview = useMemo(
    () =>
      preview
        ? {
            previewedPaths: preview.previewedPaths,
            isPreviewable: preview.isPreviewable,
            show: preview.show,
            onEditingFileChange: preview.setEditingFile,
            registerViewTarget: preview.registerViewTarget,
            renderViewControl: ({ file, iconOnly, touch }: { file: DiffFile; iconOnly: boolean; touch: boolean }) => (
              <ReviewMarkdownViewControl file={file} iconOnly={iconOnly} touch={touch} />
            ),
            render: ({ file, onHeightChange }: { file: DiffFile; onHeightChange: () => void }) => (
              <LazyBlockBoundary key={`${reviewSnapshotId ?? ''}:${file.path}`} fallback={(notice) => <MarkdownPreviewFailed notice={notice} />}>
              <React.Suspense fallback={null}>
              <MarkdownFilePreview
                key={`${reviewSnapshotId ?? ''}:${file.path}`}
                filePath={file.path}
                oldPath={file.oldPath}
                status={file.status}
                patch={file.patch}
                reviewBase={reviewBase}
                reviewSnapshotId={reviewSnapshotId}
                imageSnapshotId={snapshotId}
                imagesAvailable={imagesAvailable}
                variant="all-files"
                onHeightChange={onHeightChange}
              />
              </React.Suspense>
              </LazyBlockBoundary>
            ),
          }
        : undefined,
    [preview, reviewBase, reviewSnapshotId, snapshotId, imagesAvailable],
  );

  const leadingContent = useMemo(
    () => (commitInfo ? <CommitDescriptionHeader key={commitInfo.sha} info={commitInfo} /> : undefined),
    [commitInfo],
  );

  return (
    <AllFilesCodeView
      files={state.files}
      {...(state.callTreeHunkNotes && state.callTreeHunkNotes.length > 0 ? { hostLineNotes: state.callTreeHunkNotes } : {})}
      diffStyle={state.diffStyle}
      diffOverflow={state.diffOverflow}
      diffIndicators={state.diffIndicators}
      lineDiffType={state.lineDiffType}
      disableLineNumbers={state.disableLineNumbers}
      disableBackground={state.disableBackground}
      expandUnchanged={state.expandUnchanged}
      fontFamily={state.fontFamily}
      fontSize={state.fontSize}
      annotations={diffOnlyAnnotations}
      selectedAnnotationId={state.selectedAnnotationId}
      scrollTargetAnnotation={state.scrollTargetAnnotation}
      pendingSelection={state.pendingSelection}
      reviewBase={state.reviewBase}
      reviewSnapshotId={state.feedbackDiffContext?.snapshotId}
      contextExpansionAvailable={state.contextExpansionAvailable}
      renderImagePreview={renderImagePreview}
      renderPackageChanges={renderPackageChanges}
      markdownPreview={markdownPreview}
      compactTouchLayout={state.isCompactTouchLayout}
      onLineSelection={state.onLineSelection}
      onAddAnnotationForFile={state.onAddAnnotationForFile}
      onEditAnnotation={state.onEditAnnotation}
      onSelectAnnotation={state.onSelectAnnotation}
      onDeleteAnnotation={state.onDeleteAnnotation}
      onExplainAnnotation={state.aiAvailable ? state.onExplainAnnotation : undefined}
      agentFindingSources={state.agentFindingSources}
      onAddFileCommentForFile={state.onAddFileCommentForFile}
      viewedFiles={state.viewedFiles}
      onToggleViewed={state.onToggleViewed}
      generatedFiles={state.generatedFiles}
      expandedGeneratedFiles={state.expandedGeneratedFiles}
      onGeneratedFileCollapsedChange={state.onGeneratedFileCollapsedChange}
      showViewedControls={state.showViewedControls}
      stagedFiles={state.stagedFiles}
      onStage={state.onStage}
      canStageFiles={state.canStageFiles}
      showStageControls={state.showStageControls}
      canStagePath={state.canStagePath}
      stagingFile={state.stagingFile}
      stageError={state.stageError}
      prUrl={state.prMetadata?.url}
      prDiffScope={state.prDiffScope}
      // Debounced: marks from the raw query mid-debounce mismatch ids and re-walk every item per keystroke.
      searchQuery={state.isSearchPending ? '' : state.debouncedSearchQuery}
      searchMatches={state.searchMatches}
      activeSearchMatchId={state.activeSearchMatchId}
      activeSearchMatch={state.allFilesActiveSearchMatch}
      onCodeNavRequest={state.onCodeNavRequest}
      onTokenHoverEnter={state.onTokenHoverEnter}
      onTokenHoverLeave={state.onTokenHoverLeave}
      onTokenTarget={state.onTokenTarget}
      onVisibleFileChange={state.onAllFilesVisibleFileChange}
      onFileScrolledPast={state.onAllFilesFileScrolledPast}
      fileOrder={state.allFilesOrder}
      registerCollapseAllToggle={state.registerAllFilesCollapseToggle}
      onAllCollapsedChange={state.onAllFilesCollapsedChange}
      isActive={state.isAllFilesActive}
      aiAvailable={state.aiAvailable}
      onAskAIForFile={state.onAskAIForFile}
      isAILoading={state.isAILoading}
      onViewAIResponse={state.onViewAIResponse}
      getAIHistoryForFile={state.getAIHistoryForFile}
      defaultCollapsed={!!commitInfo}
      leadingContent={leadingContent}
      enableEditSuggestions={state.editSuggestionsEnabled}
      onAddSuggestionsForFile={state.onAddSuggestionsForFile}
      onAddEditorCommentForFile={state.onAddEditorCommentForFile}
    />
  );
};
