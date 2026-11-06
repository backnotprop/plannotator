export type { DiffFile, DiffFileStatus } from './types';
export { parseDiffToFiles } from './diffParser';
export { renderInlineMarkdown, type GuideLinkRenderer, type InlineMarkdownOptions } from './renderInlineMarkdown';
export { renderMarkdownProse } from './renderMarkdownProse';
export {
  GuideHostProvider,
  useGuideHost,
  type GuideHostValue,
  type GuideDiffRendererProps,
  type GuideDiffRendererContext,
  type GuideRevealTarget,
  type GuideActiveSearchMatch,
  type GuideGlobalComment,
  type GuideGlobalComments,
} from './host';
export { GuideGlobalCommentButton, GuideGlobalCommentList } from './GuideGlobalComments';
export { GuideView, resolveGuideSectionFiles } from './GuideView';
export { GuideSectionCard } from './GuideSectionCard';
export { GuideOverview } from './GuideOverview';
export { GuideFileCard, estimateDiffHeight } from './GuideFileCard';
export { GuideViewportProvider, useGuideFileWindow } from './GuideViewportManager';
export { GuideSectionSkeleton } from './GuideSkeleton';
export { GuideViewer, type GuideViewerProps } from './GuideViewer';
export { FileKindIcon, FILE_KIND_LABELS } from './FileKindIcon';
