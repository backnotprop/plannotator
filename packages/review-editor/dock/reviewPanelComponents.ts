import { REVIEW_PANEL_TYPES } from './reviewPanelTypes';
import { ReviewDiffPanel } from './panels/ReviewDiffPanel';
import { ReviewAgentJobDetailPanel } from './panels/ReviewAgentJobDetailPanel';
import { ReviewPROverviewPanel } from './panels/ReviewPROverviewPanel';
import { ReviewPRArtifactsPanel } from './panels/ReviewPRArtifactsPanel';
import { ReviewAllFilesDiffPanel } from './panels/ReviewAllFilesDiffPanel';
import { ReviewCodeNavPanel } from './panels/ReviewCodeNavPanel';
import { ReviewSemanticDiffPanel } from './panels/ReviewSemanticDiffPanel';

/**
 * Component registry for dockview — maps panel type strings to React components.
 * Passed to <DockviewReact components={...} />.
 */
export const reviewPanelComponents = {
  [REVIEW_PANEL_TYPES.DIFF]: ReviewDiffPanel,
  [REVIEW_PANEL_TYPES.AGENT_JOB_DETAIL]: ReviewAgentJobDetailPanel,
  [REVIEW_PANEL_TYPES.PR_OVERVIEW]: ReviewPROverviewPanel,
  [REVIEW_PANEL_TYPES.PR_ARTIFACTS]: ReviewPRArtifactsPanel,
  [REVIEW_PANEL_TYPES.ALL_FILES]: ReviewAllFilesDiffPanel,
  [REVIEW_PANEL_TYPES.CODE_NAV]: ReviewCodeNavPanel,
  [REVIEW_PANEL_TYPES.SEMANTIC_DIFF]: ReviewSemanticDiffPanel,
} as const;
