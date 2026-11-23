import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { inboxReplyQuoteExcerpt } from '@plannotator/core/inbox-reply-quote';
import { postNewThreadFromMessage } from '../data/actions/newThreadFromMessage';
import { errorToast } from '../toastError';
import type { InboxToastModel } from '../components/Toast';

/** The item on an agent's message's ⋯ menu (approved by the owner, 2026-11-23). */
export const NEW_THREAD_FROM_MESSAGE_LABEL = 'New thread from this message';

/**
 * What the message's own agent reads, as the person's reply to that message (approved by the owner, 2026-11-23,
 * word for word). A message with no words to quote (pictures only) drops the quoted part and keeps the id.
 */
export const NEW_THREAD_FROM_MESSAGE_WORDS = (excerpt: string, messageId: string): string =>
  `Move this message of yours to a new thread${excerpt ? `: "${excerpt}"` : ''} (${messageId}). Start a new thread, named as you see fit, that carries everything in it: its text, its files and its questions. Then, in this thread, withdraw only that message's open questions (they will read "No longer applies") and say where it went. Leave everything else here as it is.`;

/** Offered on a message an agent with a session wrote: a script's post (no session) has nobody to ask. */
export const newThreadFromMessageOffered = (message: InboxMessageWire): boolean => message.author.kind === 'agent' && !!message.author.session;

export const newThreadFromMessageWords = (message: InboxMessageWire): string => NEW_THREAD_FROM_MESSAGE_WORDS(inboxReplyQuoteExcerpt(message), message.id);

/**
 * Ask the message's agent: a plain reply to that very message, so it goes to the session that wrote it (however many
 * agents share the thread), is kept in the thread, wakes or waits as any reply does, and can be taken back like one.
 */
export async function askNewThreadFromMessage(
  message: InboxMessageWire,
  host: { onToast?: (toast: Omit<InboxToastModel, 'id'>) => void; onChanged?: () => Promise<void> | void },
): Promise<void> {
  try {
    await postNewThreadFromMessage(message.id, newThreadFromMessageWords(message));
  } catch (cause) {
    host.onToast?.(errorToast(cause, 'That did not work; try again.'));
    return;
  }
  await host.onChanged?.();
}
