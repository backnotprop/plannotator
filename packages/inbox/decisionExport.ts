/**
 * Export decisions in the thread's ⋯ More (design brief "export-decisions", 2026-11-10): when it shows, and where each
 * download comes from. The documents are built by the server (packages/shared/inbox/decision-export*.ts) from the same
 * question records the thread shows; this window only links to them.
 */
import type { InboxThread } from '@plannotator/core/inbox-types';
import { inboxUrl, machineOf } from './inboxUrl';

export type DecisionExportDownload = 'md' | 'html';

/** The item shows only on a thread with question cards (action items are not questions). */
export function threadHasQuestionCards(thread: Pick<InboxThread, 'messages'>): boolean {
  return thread.messages.some((message) => message.questions?.some((question) => question.kind !== 'action') ?? false);
}

/** The reader's zone, so the file's dates read as the window's. */
function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The download's address: relative, so it works wherever the window was opened (localhost, the tailnet, a tunnel),
 * and through this Inbox's forward for a linked machine's thread.
 */
export function decisionExportUrl(threadId: string, format: DecisionExportDownload): string {
  const query = new URLSearchParams({ format, tz: readerZone() }).toString();
  return inboxUrl(`/threads/${encodeURIComponent(threadId)}/decisions`, query, machineOf(threadId));
}
