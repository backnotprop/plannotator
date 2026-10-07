import type { AskAIParams } from '@plannotator/ui/hooks/useAIChat';

/**
 * The annotation context that rides with a side-chat Ask AI question (#1748).
 *
 * "Ask this session" answers in the agent session the review is FOR, with its
 * tools, so it never gets the submitted-feedback export of the reviewer's
 * drafts (it carried them out, then got them again on Submit). It gets the
 * plain draft list (`formatDraftAnnotationsForAsk`) instead, which the hook
 * sends only when it changed and the server frames as read-only context.
 *
 * A separate AI keeps what it always had: the export as `contextUpdate` on
 * every question after the first (the first one's session context carries it).
 */
export function askAIAnnotationParams(options: {
  sessionBridge: boolean;
  hasSession: boolean;
  /** The feedback export of the current annotations; undefined when none. */
  feedbackExport: string | undefined;
  /** The current drafts as a plain list; '' when none. */
  draftList: () => string;
}): Pick<AskAIParams, 'contextUpdate' | 'draftAnnotations'> {
  if (options.sessionBridge) return { draftAnnotations: options.draftList() };
  return { contextUpdate: options.hasSession ? options.feedbackExport : undefined };
}
