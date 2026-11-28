import { InboxApiError, inboxApi } from '../../api';

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

export const REPLY_LANDED_MS = 10_000;

export async function replyLanded(threadId: string, key: string, timeoutMs = REPLY_LANDED_MS): Promise<'yes' | 'no' | 'unknown' | 'gone'> {
  try {
    const read = await inboxApi.thread(threadId, timeoutMs);
    return read.thread.messages.some((m) => m.author.kind === 'person' && m.idempotency_key === key) ? 'yes' : 'no';
  } catch (cause) {
    return cause instanceof InboxApiError && cause.status === 404 ? 'gone' : 'unknown';
  }
}

export const sendErrors = new Map<string, string>();
