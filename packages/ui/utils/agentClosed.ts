/**
 * Copy for a review the agent closed (`POST /api/host/close`,
 * packages/shared/host-control.ts). The tab learns it from the
 * `session-closed` event on the external-annotation stream.
 *
 * The close keeps the draft; what brings it back depends on the draft's key,
 * so the copy names the case:
 *  - `file` / `folder`: a local file's draft follows its PATH as well as its
 *    text (packages/shared/annotate-draft.ts), so it comes back even after
 *    the file was edited. A folder's files each carry their own copy.
 *  - `document`: a URL or an agent message is keyed by its content only, so
 *    only the same, unchanged document brings it back.
 *  - `app`: a live app is keyed by its address.
 *  - `changes`: code review, keyed by the patch (or the PR).
 */

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
 * Copy for a plan review closed because plan mode or the agent session ended
 * (`session-closed` with `by: "session"`, Pi's plan review), not because the
 * agent asked to close it.
 */
export const SESSION_CLOSED_TITLE = 'Plan Mode Ended';

export function sessionClosedSubtitle(unsentAnnotations: number): string {
  if (unsentAnnotations <= 0) return 'Plan mode ended in the agent session.';
  const comments = unsentAnnotations === 1 ? 'Your comment is' : `Your ${unsentAnnotations} comments are`;
  return `Plan mode ended in the agent session. ${comments} saved.`;
}

/** Title and subtitle for a closed review, by who closed it. */
export function closedReviewCopy(
  closed: { unsentAnnotations: number; by?: 'agent' | 'session' },
  surface: AgentClosedSurface = 'document',
): { title: string; subtitle: string } {
  if (closed.by === 'session') {
    return { title: SESSION_CLOSED_TITLE, subtitle: sessionClosedSubtitle(closed.unsentAnnotations) };
  }
  return { title: AGENT_CLOSED_TITLE, subtitle: agentClosedSubtitle(closed.unsentAnnotations, surface) };
}
