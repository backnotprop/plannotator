import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { inboxReplyQuoteExcerpt } from '@plannotator/core/inbox-reply-quote';
import { NEW_THREAD_FROM_MESSAGE_WORDS } from '@plannotator/core/inbox-reply-quote';
import { postNewThreadFromMessage } from '../data/actions/newThreadFromMessage';
import { errorToast } from '../toastError';
import type { InboxToastModel } from '../components/Toast';

/** The item on an agent's message's ⋯ menu (approved by the owner, 2026-11-23). */
export const NEW_THREAD_FROM_MESSAGE_LABEL = 'New thread from this message';

/** The words (packages/core/inbox-reply-quote.ts, approved 2026-11-23): one constant, shared with the store. */
export { NEW_THREAD_FROM_MESSAGE_WORDS };

/** Offered on a message an agent with a session wrote: a script's post (no session) has nobody to ask. */
export const newThreadFromMessageOffered = (message: InboxMessageWire): boolean => message.author.kind === 'agent' && !!message.author.session;

/** The messages whose ask is on its way: a second press sends nothing, and the item is off until it lands. */
const sending = new Set<string>();
export const newThreadFromMessageSending = (messageId: string): boolean => sending.has(messageId);

export const newThreadFromMessageWords = (message: InboxMessageWire): string => NEW_THREAD_FROM_MESSAGE_WORDS(inboxReplyQuoteExcerpt(message), message.id);

/**
 * Ask the message's agent: a plain reply to that very message, so it goes to the session that wrote it (however many
 * agents share the thread), is kept in the thread, wakes or waits as any reply does, and can be taken back like one.
 */
export async function askNewThreadFromMessage(
  message: InboxMessageWire,
  host: { onToast?: (toast: Omit<InboxToastModel, 'id'>) => void; onChanged?: () => Promise<void> | void },
): Promise<void> {
  if (sending.has(message.id)) return;
  sending.add(message.id);
  try {
    await postNewThreadFromMessage(message.id, newThreadFromMessageWords(message));
  } catch (cause) {
    host.onToast?.(errorToast(cause, 'That did not work; try again.'));
    return;
  } finally {
    sending.delete(message.id);
  }
  await host.onChanged?.();
}
