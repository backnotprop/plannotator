import { InboxApiError, inboxApi } from '../../api';
import { InboxWriteTimeout } from '../../apiWrite';
import { dropKept, forgetWords, keepLate, keptLateGone } from '../../replyWordsKept';
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
/**
 * The Sends not confirmed, by thread. One given up with no answer (`late`) is kept in the browser too
 * (replyWordsKept.ts), so a reload between the timeout and Send again still sends that reply under its keys; set and
 * delete keep that copy in step. `clear` (tests: the next case) lets go of both.
 */
class Unconfirmed extends Map<string, UnconfirmedSend> {
  override set(threadId: string, send: UnconfirmedSend): this {
    super.set(threadId, send);
    if (send.late) keepLate(threadId, send.words, keptOf(send));
    else forgetWords(threadId, ':late');
    return this;
  }
  override delete(threadId: string): boolean {
    forgetWords(threadId, ':late');
    return super.delete(threadId);
  }
  override clear(): void {
    for (const threadId of this.keys()) forgetWords(threadId, ':late');
    super.clear();
  }
}
export const unconfirmed: Map<string, UnconfirmedSend> = new Unconfirmed();
export const UNCONFIRMED_MS = 10 * 60_000;
/** A Send given up is looked for after a reload for this long: past it, Send again is an ordinary Send. */
export const LATE_KEPT_MS = 24 * 60 * 60_000;

/** The record as the browser keeps it (its maps as lists). */
const keptOf = (send: UnconfirmedSend) => ({ ...send, late: { keys: send.late?.keys ? [...send.late.keys] : null, contents: send.late?.contents ? [...send.late.contents] : null } });

/** A record the browser kept, read back; null when it is not one (another version's, or damaged). */
function sendOf(kept: unknown): UnconfirmedSend | null {
  const k = kept as Partial<Record<keyof UnconfirmedSend, unknown>> & { late?: { keys?: unknown; contents?: unknown } };
  const strings = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === 'string');
  const pairs = (list: unknown) => list === null || (Array.isArray(list) && list.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string'));
  if (typeof k.key !== 'string' || typeof k.words !== 'string' || typeof k.at !== 'number' || !strings(k.uploads) || !strings(k.comments) || !strings(k.picks)) return null;
  if (!k.late || !pairs(k.late.keys) || !pairs(k.late.contents)) return null;
  const keys = k.late.keys as [string, string][] | null;
  const contents = k.late.contents as [string, SentContents][] | null;
  return { ...(k as UnconfirmedSend), late: { keys: keys && new Map(keys), contents: contents && new Map(contents) } };
}

/**
 * The thread opens: `apply` gets the keys of a Send given up there (its `late`), or null. With none in this page, one a
 * page now gone kept (a reload, a tab the browser ended) comes back, under a day old, while `still()` (the same thread
 * open, no Send started): it is the record again, and `apply` gets its keys.
 */
export function lateKeysOf(threadId: string, still: () => boolean, apply: (late: UnconfirmedSend['late'] | null) => void): void {
  const here = unconfirmed.get(threadId);
  apply(here?.late ?? null);
  if (here) return;
  void keptLateGone(threadId).then((found) => {
    const send = found ? sendOf(found.send) : null;
    if (!found) return;
    dropKept(found.key);
    if (!send || Date.now() - send.at > LATE_KEPT_MS || unconfirmed.has(threadId)) return;
    unconfirmed.set(threadId, send);
    if (still()) apply(send.late ?? null);
  });
}

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
