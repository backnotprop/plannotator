/**
 * What a failed Send says (approval "inbox-reply-box", decision D3): one plain line, and the Inbox's own words behind
 * Details when they are not already that line. The person must see at once that nothing went; a path, an errno or a
 * 230-character server message is for the Details.
 *
 * - A refusal (4xx) the Inbox wrote for people, short and with no path in it, is the line as it is: it says what to do.
 * - The disk is full (an upload's `upload_no_space`, or ENOSPC in the words of a reply the Inbox could not write):
 *   "The reply was not sent: the disk is full. …".
 * - Any other failure of the Inbox (5xx): "The reply was not sent: the Inbox could not write it. Send again to retry."
 * - No answer at all (the Inbox is down, the network dropped): "The reply was not sent. Send again to retry."
 * - Given up with nothing arriving (`InboxWriteTimeout`): the request may still be on its way (a slow Inbox, a phone's
 *   connection sending it again after a network change), so "was not sent" could be false: `SEND_MAY_NOT_HAVE_GONE`.
 */
import { InboxApiError } from './api';
import { InboxWriteTimeout } from './apiWrite';

export interface SendFailure {
  line: string;
  details: string | null;
}

/** Past this, a server's words are details, not a line. */
const LINE_MAX = 160;
/** A path (`/Users/…/inbox/x.jsonl`, `C:\…`) or an errno code: words for the Details, not the line. */
const TECHNICAL = /(?:^|[\s'"(])(?:\/[^\s/'"]+){2,}|[A-Za-z]:\\|\bE[A-Z]{3,}\b/;

export const SEND_NOT_SENT = 'The reply was not sent. Send again to retry.';
/** A Send pressed while a file still uploads (the reply box's controller says it; Thread.tsx says the same words). */
export const UPLOADING_LINE = 'Wait for the files to finish uploading.';
/** A Send whose reply may have gone: its next Send looks for it first (`unconfirmed` in data/actions/sendLanded.ts). */
export const SEND_MAY_NOT_HAVE_GONE = 'The reply may not have gone. Send again: it looks for this one first, so it is not sent twice.';

export function sendFailure(cause: unknown, reread?: () => unknown): SendFailure {
  if (cause instanceof InboxApiError && cause.code === 'question_answered_in_reply') void reread?.();
  if (!(cause instanceof InboxApiError)) {
    const words = cause instanceof Error && cause.message ? cause.message : null;
    const line = cause instanceof InboxWriteTimeout ? SEND_MAY_NOT_HAVE_GONE : SEND_NOT_SENT;
    return { line, details: words && words !== line ? words : null };
  }
  const words = cause.message.trim();
  const plain = words.length > 0 && words.length <= LINE_MAX && !TECHNICAL.test(words);
  if (cause.status < 500 && plain) return { line: words, details: null };
  const full = cause.code === 'upload_no_space' || /\bENOSPC\b/.test(words);
  const line = full
    ? 'The reply was not sent: the disk is full. Free some space, then send again.'
    : cause.status >= 500
      ? 'The reply was not sent: the Inbox could not write it. Send again to retry.'
      : 'The reply was not sent.';
  // "Internal error." says nothing the line does not, nor do an upload's disk-full words (an ENOSPC's say where).
  const details = words && cause.code !== 'upload_no_space' && words !== 'Internal error.' && words !== line ? words : null;
  return { line, details };
}
