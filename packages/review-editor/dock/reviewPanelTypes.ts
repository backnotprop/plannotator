/**
 * Review-specific dockview panel type constants and ID factory functions.
 *
 * The "review-" prefix scopes these to the code review context,
 * distinguishing them from any future plan editor panel types.
 */

export const REVIEW_PANEL_TYPES = {
  DIFF: 'review-diff',
  AGENT_JOB_DETAIL: 'review-agent-job-detail',
  PR_SUMMARY: 'review-pr-summary',
  PR_COMMENTS: 'review-pr-comments',
  PR_CHECKS: 'review-pr-checks',
  ALL_FILES: 'review-all-files',
} as const;

export const REVIEW_DIFF_PANEL_ID = 'review-diff';

export interface ReviewDiffPanelParams {
  filePath: string;
}

export const makeReviewAgentJobPanelId = (jobId: string) =>
  `review-agent-job:${jobId}`;

export const REVIEW_PR_SUMMARY_PANEL_ID = 'review-pr-summary';
export const REVIEW_PR_COMMENTS_PANEL_ID = 'review-pr-comments';
export const REVIEW_PR_CHECKS_PANEL_ID = 'review-pr-checks';
export const REVIEW_ALL_FILES_PANEL_ID = 'review-all-files';

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
