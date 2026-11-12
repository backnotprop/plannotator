import type { InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi, type DecisionsPostTo } from './api';
import type { InboxToastModel } from './components/Toast';
import { inboxUrl, machineOf } from './inboxUrl';

export type DecisionExportDownload = 'md' | 'html';

export function threadHasQuestionCards(thread: Pick<InboxThread, 'messages'>): boolean {
  return thread.messages.some((message) => message.questions?.some((question) => question.kind !== 'action') ?? false);
}

function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function decisionExportUrl(threadId: string, format: DecisionExportDownload): string {
  const query = new URLSearchParams({ format, tz: readerZone() }).toString();
  return inboxUrl(`/threads/${encodeURIComponent(threadId)}/decisions`, query, machineOf(threadId));
}

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

export const DECISIONS_POST_TO_WORDS: readonly { value: DecisionsPostTo; label: string }[] = [
  { value: 'description', label: 'In the description' },
  { value: 'comment', label: 'As a comment' },
  { value: 'both', label: 'Short in the description, full in a comment' },
];
