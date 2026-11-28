import { InboxApiError, inboxApi } from '../../api';
import { InboxWriteTimeout } from '../../apiWrite';
import type { SentContents } from '../../sendTargets';

/** The Send was given up with nothing arriving: it may still land (see `UnconfirmedSend.late`). */
export const gaveUp = (cause: unknown): boolean => cause instanceof InboxWriteTimeout;

export interface UnconfirmedSend {
  key: string;
  words: string;
  uploads: string[];
  comments: string[];
  picks: string[];
  at: number;
  /**
   * Given up with no answer (`InboxWriteTimeout`): the request may still be on its way (a slow Inbox, a phone's
   * connection sending it again after a network change), so the read back's "not there" is not the end. The window
   * keeps watching for it through an edit and when the thread is left (a thread read that shows it says it went), and
   * keeps this Send's keys with its words (`keys`, `contents`): Send again of the same words is that reply, never a
   * second, even after leaving and coming back.
   */
  late?: { keys: Map<string, string> | null; contents: Map<string, SentContents> | null };
}

/** The record of a Send not confirmed: its words' key and what it carried (the picks a reply carries are the questions it names). */
export function unconfirmedSend(
  key: string,
  words: string,
  uploads: string[],
  requests: readonly { messageId: string; input: { annotation_ids?: string[]; questions?: readonly { key: string }[] } }[],
  late?: UnconfirmedSend['late'],
): UnconfirmedSend {
  return {
    key,
    words,
    uploads,
    comments: requests.flatMap((r) => r.input.annotation_ids ?? []),
    picks: requests.flatMap((r) => (r.input.questions ?? []).map((q) => `${r.messageId}/${q.key}`)),
    at: Date.now(),
    ...(late ? { late } : {}),
  };
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
