/**
 * Whether a Send's reply landed, when its answer never came back: each reply carries an idempotency key, kept across
 * retries, and the thread read shows the reply with it once the Inbox took it (Thread.tsx's Send asks before it sends
 * the same words again, and after a Send whose answer was lost). This is what makes drawing a Send before the server
 * answers safe (sendDraw.ts): a Send never posts what already landed.
 */
import { InboxApiError, inboxApi } from '../../api';

/**
 * Per thread, a Send whose reply carrying the words went out but could not be
 * confirmed (its answer was lost and the thread could not be read: the Inbox
 * may be down): its key, and what it carried. It holds only while the box
 * keeps exactly those unsent words: it goes when any thread read shows the
 * reply landed (the Send is then finished), when the words change or the box
 * empties, when the person leaves the thread, and after 10 minutes. The next
 * Send of those words first reads the thread for that reply: there, the Send
 * is finished and nothing goes again; not there, it is an ordinary new Send.
 */
export interface UnconfirmedSend {
  key: string;
  words: string;
  uploads: string[];
  comments: string[];
  picks: string[];
  at: number;
}
export const unconfirmed = new Map<string, UnconfirmedSend>();
export const UNCONFIRMED_MS = 10 * 60_000;

/**
 * Whether a reply with this idempotency key is in the thread: 'unknown' when
 * the thread could not be read, 'gone' when the thread no longer exists.
 */
export async function replyLanded(threadId: string, key: string): Promise<'yes' | 'no' | 'unknown' | 'gone'> {
  try {
    const read = await inboxApi.thread(threadId);
    return read.thread.messages.some((m) => m.author.kind === 'person' && m.idempotency_key === key) ? 'yes' : 'no';
  } catch (cause) {
    return cause instanceof InboxApiError && cause.status === 404 ? 'gone' : 'unknown';
  }
}
