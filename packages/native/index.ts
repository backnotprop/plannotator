/**
 * @plannotator/native
 * React Native components for plan review and annotation
 *
 * Usage in Happy:
 * ```tsx
 * import { PlannotatorModal } from '@plannotator/native';
 *
 * <PlannotatorModal
 *   visible={showReview}
 *   onClose={() => setShowReview(false)}
 *   planMarkdown={planContent}
 *   onApprove={handleApprove}
 *   onSendFeedback={handleFeedback}
 * />
 * ```
 */

// Re-export core types and functions
export * from '@plannotator/core';

// Native types
export * from './types';

// Components
export { PlannotatorModal } from './components/PlannotatorModal';
export { PlanViewer } from './components/PlanViewer';
export { BlockRenderer } from './components/BlockRenderer';
export { CodeBlock } from './components/CodeBlock';
export { AnnotationToolbar } from './components/AnnotationToolbar';
export { AnnotationPanel } from './components/AnnotationPanel';
export { InlineMarkdown } from './components/InlineMarkdown';

// Hooks
export { useAnnotations, createAnnotation } from './hooks/useAnnotations';
export type { UseAnnotationsReturn } from './hooks/useAnnotations';

export { usePlanReview } from './hooks/usePlanReview';
export type { UsePlanReviewReturn, ReviewResult, PlanReviewOptions } from './hooks/usePlanReview';

export { useTextSelection } from './hooks/useTextSelection';
export type { UseTextSelectionReturn } from './hooks/useTextSelection';
