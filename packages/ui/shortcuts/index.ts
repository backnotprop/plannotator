export * from './core';
export * from './runtime';

// plan-review scopes
export { annotationToolbarShortcuts, useAnnotationToolbarShortcuts } from './plan-review/annotationToolbar.shortcuts';
export { annotationPanelShortcuts, useAnnotationPanelShortcuts } from './plan-review/annotationPanel.shortcuts';
export { commentPopoverShortcuts } from './plan-review/commentPopover.shortcuts';
export { imageAnnotatorShortcuts, useImageAnnotatorShortcuts } from './plan-review/imageAnnotator.shortcuts';
export { inputMethodShortcuts } from './plan-review/inputMethod.shortcuts';
export { viewerShortcuts, useViewerShortcuts } from './plan-review/viewer.shortcuts';

// code-review scopes
export { reviewAnnotationToolbarShortcuts, useReviewAnnotationToolbarShortcuts } from './code-review/annotationToolbar.shortcuts';
export { reviewFileTreeShortcuts, useReviewFileTreeShortcuts } from './code-review/fileTree.shortcuts';
export { reviewPrCommentsShortcuts, useReviewPrCommentsShortcuts } from './code-review/prComments.shortcuts';
export { reviewAllFilesDiffShortcuts, useReviewAllFilesDiffShortcuts } from './code-review/allFilesDiff.shortcuts';
export { reviewAiShortcuts, useReviewAiShortcuts } from './code-review/ai.shortcuts';
export { reviewSuggestionModalShortcuts, useReviewSuggestionModalShortcuts } from './code-review/suggestionModal.shortcuts';
export { reviewTourDialogShortcuts, useReviewTourDialogShortcuts } from './code-review/tourDialog.shortcuts';
