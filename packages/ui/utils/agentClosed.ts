/** Copy for a review the agent closed (`POST /api/host/close`, packages/shared/host-control.ts). */

export const AGENT_CLOSED_TITLE = 'Closed by the Agent';

export type AgentClosedSurface = 'file' | 'folder' | 'document' | 'app' | 'changes';

const RESTORE: Record<AgentClosedSurface, string> = {
  file: 'Opening the file again brings it back, even after it is edited.',
  folder: 'Opening the folder or its files again brings it back, even after they are edited.',
  document: 'Reopening the same document, unchanged, brings it back.',
  app: 'Opening the same app again brings it back.',
  changes: 'Reopening a review of the same changes brings it back.',
};

export function agentClosedSubtitle(unsentAnnotations: number, surface: AgentClosedSurface = 'document'): string {
  if (unsentAnnotations <= 0) return 'The agent closed this review.';
  const comments = unsentAnnotations === 1 ? 'Your comment is' : `Your ${unsentAnnotations} comments are`;
  return `The agent closed this review. ${comments} saved as a draft. ${RESTORE[surface]}`;
}

/**
 * Copy for a plan review closed because plan mode or the agent session ended (`session-closed`
 * with `by: "session"`, Pi's plan review).
 */
export const SESSION_CLOSED_TITLE = 'Review Closed';

export function sessionClosedSubtitle(unsentAnnotations: number): string {
  const ended = 'The agent session that opened this plan review ended.';
  if (unsentAnnotations <= 0) return ended;
  const comments = unsentAnnotations === 1 ? 'Your comment is' : `Your ${unsentAnnotations} comments are`;
  return `${ended} ${comments} saved.`;
}

export function closedReviewCopy(
  closed: { unsentAnnotations: number; by?: 'agent' | 'session' },
  surface: AgentClosedSurface = 'document',
): { title: string; subtitle: string } {
  if (closed.by === 'session') {
    return { title: SESSION_CLOSED_TITLE, subtitle: sessionClosedSubtitle(closed.unsentAnnotations) };
  }
  return { title: AGENT_CLOSED_TITLE, subtitle: agentClosedSubtitle(closed.unsentAnnotations, surface) };
}
