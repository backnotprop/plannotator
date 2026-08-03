import React, { useMemo } from 'react';
import type { GuideDiffRef } from '@plannotator/shared/guide';
import { renderInlineMarkdown } from '../../utils/renderInlineMarkdown';
import { DiffViewer } from '../DiffViewer';
import { useReviewState } from '../../dock/ReviewStateContext';
import { annotationMatchesPrScope } from '../../utils/annotationScope';

/** Approximate rendered height for a single-file patch: ~21px per diff line
 *  plus the file header, clamped so tiny diffs don't waste space and huge
 *  ones stay a bounded, internally-scrolling box within the page scroll. */
function estimateDiffHeight(patch: string): number {
  const lineCount = patch.split('\n').length;
  return Math.max(150, Math.min(lineCount * 21 + 52, 620));
}

interface GuideDiffSectionProps {
  diffRef: GuideDiffRef;
  /** True when this is the single guide-local "focused" diff (arbitrated by
   *  the parent GuideScreen via pointerenter/focus — never derived from the
   *  dock's focusedFilePath, which is null while the guide is open). */
  isFocused: boolean;
  onFocus: () => void;
}

/**
 * Guided Review's per-diff adapter — the annotation-parity piece.
 *
 * Mirrors ReviewDiffPanel's DiffViewer prop bag exactly, with two differences:
 * annotation-adding handlers are bound to `diffRef.file` explicitly (the
 * generic `state.onAddAnnotation` / `state.onAskAI` resolve their target file
 * from the dock's `activeFileIndex`, which has no meaning here — multiple
 * GuideDiffSection instances are mounted at once on one scrolling page, not
 * behind a single active dockview tab), and `isFocused` comes from the guide
 * screen's own single-focus arbiter instead of `state.focusedFilePath`.
 */
export const GuideDiffSection: React.FC<GuideDiffSectionProps> = ({ diffRef, isFocused, onFocus }) => {
  const state = useReviewState();
  const file = useMemo(
    () => state.files.find((candidate) => candidate.path === diffRef.file),
    [state.files, diffRef.file],
  );

  const fileAnnotations = useMemo(() => {
    if (!file) return [];
    const currentPrUrl = state.prMetadata?.url;
    const currentDiffScope = state.prDiffScope;
    return state.allAnnotations.filter(
      (a) => a.filePath === file.path && annotationMatchesPrScope(a, currentPrUrl, currentDiffScope),
    );
  }, [state.allAnnotations, file, state.prMetadata, state.prDiffScope]);

  const aiMessagesForFile = useMemo(
    () => (file ? state.aiMessages.filter((m) => m.question.filePath === file.path) : []),
    [state.aiMessages, file],
  );

  const aiHistoryForFile = useMemo(
    () => (file ? state.getAIHistoryForFile(file.path) : []),
    [state.getAIHistoryForFile, file],
  );

  // Re-splitting the whole patch string on every re-render is wasteful — focus
  // changes re-render every mounted GuideDiffSection (isFocused flips), not
  // just the one gaining focus. Recompute only when the patch text itself changes.
  const diffHeight = useMemo(() => (file ? estimateDiffHeight(file.patch) : 0), [file?.patch]);

  if (!file) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-border/50 bg-muted/10 text-xs text-muted-foreground"
        title="This file no longer appears in the current diff — the guide may be out of date."
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="flex-shrink-0 text-muted-foreground/60">
          <path d="M8 5v3.5M8 11h.007M14.5 8A6.5 6.5 0 1 1 1.5 8a6.5 6.5 0 0 1 13 0Z" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span className="font-mono truncate flex-1">{diffRef.file}</span>
        <span className="flex-shrink-0 uppercase tracking-wider text-[10px]">no longer in the current diff</span>
      </div>
    );
  }

  return (
    <div onPointerEnter={onFocus} onFocus={onFocus}>
      {diffRef.summary && (
        <p className="mb-1.5 px-1 text-xs leading-relaxed text-muted-foreground">
          {renderInlineMarkdown(diffRef.summary)}
        </p>
      )}
      {/* DiffViewer is `h-full flex flex-col` internally (FileHeader + its own
          scrolling body) — it fills whatever height its parent gives it rather
          than growing to fit content. The guide page is one continuous scroll
          container, so each diff gets a bounded box sized to its patch (small
          diffs render at natural height, tall ones cap and scroll internally). */}
      <div
        key={`${file.path}:${state.reviewBase ?? ''}:${state.activeDiffBase ?? ''}:${state.feedbackDiffContext?.snapshotId ?? ''}`}
        style={{ height: diffHeight }}
        className="rounded-lg border border-border/40 overflow-hidden"
      >
        <DiffViewer
          patch={file.patch}
          filePath={file.path}
          oldPath={file.oldPath}
          status={file.status}
          reviewBase={state.reviewBase}
          reviewSnapshotId={state.feedbackDiffContext?.snapshotId}
          prUrl={state.prMetadata?.url}
          prDiffScope={state.prDiffScope}
          isFocused={isFocused}
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
          // pendingSelection has no file identity — it always originates in
          // whichever viewer the user's pointer is in. Gating it on the guide
          // focus arbiter keeps every OTHER visible guide DiffViewer from also
          // painting the highlight and auto-scrolling to it.
          pendingSelection={isFocused ? state.pendingSelection : null}
          onLineSelection={state.onLineSelection}
          onAddAnnotation={(type, text, suggestedCode, originalCode, conventionalLabel, decorations, tokenMeta) =>
            state.onAddAnnotationForFile(file.path, type, text, suggestedCode, originalCode, conventionalLabel, decorations, tokenMeta)
          }
          onAddFileComment={(text) => state.onAddFileCommentForFile(file.path, text)}
          onEditAnnotation={state.onEditAnnotation}
          onSelectAnnotation={state.onSelectAnnotation}
          onDeleteAnnotation={state.onDeleteAnnotation}
          isViewed={state.viewedFiles.has(file.path)}
          onToggleViewed={() => state.onToggleViewed(file.path)}
          isStaged={state.stagedFiles.has(file.path)}
          isStaging={state.stagingFile === file.path}
          onStage={() => state.onStage(file.path)}
          // Per-file gate, not the mode-level flag alone: canStageFiles by
          // itself let committed-only files in since-base reviews show a Git
          // Add that no-ops and records a false staged state.
          canStage={state.canStagePath?.(file.path) ?? state.canStageFiles}
          stageError={state.stageError}
          aiAvailable={state.aiAvailable}
          onAskAI={(question) => state.onAskAIForFile(file.path, question)}
          isAILoading={state.isAILoading}
          onViewAIResponse={state.onViewAIResponse}
          aiMessages={aiMessagesForFile}
          onClickAIMarker={state.onClickAIMarker}
          aiHistoryMessages={isFocused ? aiHistoryForFile : []}
          onCodeNavRequest={state.onCodeNavRequest}
        />
      </div>
    </div>
  );
};
