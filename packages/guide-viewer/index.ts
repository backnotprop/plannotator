export type { DiffFile, DiffFileStatus } from './types';
export { parseDiffToFiles } from './diffParser';
export { renderInlineMarkdown } from './renderInlineMarkdown';
export { renderMarkdownProse } from './renderMarkdownProse';
export {
  GuideHostProvider,
  useGuideHost,
  type GuideHostValue,
  type GuideDiffRendererProps,
  type GuideDiffRendererContext,
  type GuideRevealTarget,
  type GuideActiveSearchMatch,
} from './host';
export { GuideView, resolveGuideSectionFiles } from './GuideView';
export { GuideSectionCard } from './GuideSectionCard';
export { GuideFileCard, estimateDiffHeight } from './GuideFileCard';
export { GuideViewportProvider, useGuideFileWindow, GUIDE_MAX_MOUNTED_CODE_VIEWS } from './GuideViewportManager';
export { GuideSectionSkeleton } from './GuideSkeleton';
export { GuideViewer, type GuideViewerProps } from './GuideViewer';
