import { REVIEW_PANEL_TYPES } from './reviewPanelTypes';
import { ReviewDiffPanel } from './panels/ReviewDiffPanel';
import { ReviewAgentJobDetailPanel } from './panels/ReviewAgentJobDetailPanel';
import { ReviewPRSummaryPanel } from './panels/ReviewPRSummaryPanel';
import { ReviewPRCommentsPanel } from './panels/ReviewPRCommentsPanel';
import { ReviewPRChecksPanel } from './panels/ReviewPRChecksPanel';
import { ReviewAllFilesDiffPanel } from './panels/ReviewAllFilesDiffPanel';

/**
 * Component registry for dockview — maps panel type strings to React components.
 * Passed to <DockviewReact components={...} />.
 */
export const reviewPanelComponents = {
  [REVIEW_PANEL_TYPES.DIFF]: ReviewDiffPanel,
  [REVIEW_PANEL_TYPES.AGENT_JOB_DETAIL]: ReviewAgentJobDetailPanel,
  [REVIEW_PANEL_TYPES.PR_SUMMARY]: ReviewPRSummaryPanel,
  [REVIEW_PANEL_TYPES.PR_COMMENTS]: ReviewPRCommentsPanel,
  [REVIEW_PANEL_TYPES.PR_CHECKS]: ReviewPRChecksPanel,
  [REVIEW_PANEL_TYPES.ALL_FILES]: ReviewAllFilesDiffPanel,
} as const;
