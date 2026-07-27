/**
 * Review-specific dockview panel type constants and ID factory functions.
 *
 * The "review-" prefix scopes these to the code review context,
 * distinguishing them from any future plan editor panel types.
 */

export const REVIEW_PANEL_TYPES = {
  DIFF: 'review-diff',
  AGENT_JOB_DETAIL: 'review-agent-job-detail',
  PR_OVERVIEW: 'review-pr-overview',
  PR_ARTIFACTS: 'review-pr-artifacts',
  ALL_FILES: 'review-all-files',
  CODE_NAV: 'review-code-nav',
  SEMANTIC_DIFF: 'review-semantic-diff',
} as const;

export const REVIEW_DIFF_PANEL_ID = 'review-diff';

export interface ReviewDiffPanelParams {
  filePath: string;
}

export const makeReviewAgentJobPanelId = (jobId: string) =>
  `review-agent-job:${jobId}`;

export const REVIEW_PR_OVERVIEW_PANEL_ID = 'review-pr-overview';
export const REVIEW_PR_ARTIFACTS_PANEL_ID = 'review-pr-artifacts';
export const REVIEW_ALL_FILES_PANEL_ID = 'review-all-files';
export const REVIEW_CODE_NAV_PANEL_ID = 'review-code-nav';
export const REVIEW_SEMANTIC_DIFF_PANEL_ID = 'review-semantic-diff';

export function isReviewDiffPanelId(panelId: string): boolean {
  return panelId === REVIEW_DIFF_PANEL_ID;
}

export function getReviewDiffPanelFilePath(
  params: unknown,
): string | null {
  if (!params || typeof params !== 'object') return null;
  const filePath = (params as { filePath?: unknown }).filePath;
  return typeof filePath === 'string' ? filePath : null;
}
