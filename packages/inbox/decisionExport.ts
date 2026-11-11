/**
 * Export decisions in the thread's ⋯ More (design brief "export-decisions", 2026-11-10): when it shows, and where each
 * download comes from. The documents are built by the server (packages/shared/inbox/decision-export*.ts) from the same
 * question records the thread shows; this window only links to them.
 */
import type { InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi, type DecisionsPostTo } from './api';
import type { InboxToastModel } from './components/Toast';
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

/**
 * Post decisions (step 2): the thread's decisions on `ref`, one of its PRs, where the person's setting says (the
 * description by default), edited in place when posted again. One click, no dialog; the toast says where it went with
 * Open, that it went as a comment instead (and why), or what to do when it did not go.
 */
export async function postDecisions(threadId: string, ref: string, onToast?: (toast: Omit<InboxToastModel, 'id'>) => void): Promise<void> {
  try {
    const answer = await inboxApi.postThreadDecisions(threadId, ref, readerZone());
    const open = answer.url.startsWith('https://') ? { action: { label: 'Open', onPress: () => void window.open(answer.url, '_blank', 'noopener,noreferrer') } } : {};
    if (answer.fallback) {
      onToast?.({
        icon: 'check',
        lead: `Decisions posted on ${answer.ref} as a comment instead`,
        detail: answer.fallback === 'no_permission' ? "You can't edit its description." : 'Too long for its description.',
        ...open,
      });
      return;
    }
    onToast?.({ icon: 'check', lead: `Decisions ${answer.action === 'updated' ? 'updated' : 'posted'} on ${answer.ref}`, ...open });
  } catch (cause) {
    onToast?.({ icon: 'warn', lead: cause instanceof Error && cause.message ? cause.message : `Couldn't post on ${ref}. Try again.`, wrap: true });
  }
}

/** The Post group's "Where to post": its words, in the order shown. */
export const DECISIONS_POST_TO_WORDS: readonly { value: DecisionsPostTo; label: string }[] = [
  { value: 'description', label: 'In the description' },
  { value: 'comment', label: 'As a comment' },
  { value: 'both', label: 'Short in the description, full in a comment' },
];
