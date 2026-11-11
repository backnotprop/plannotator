/** One plain line says nothing went; the Inbox's own words go behind Details. Paths, errnos and long server messages are for the Details only. */
import { InboxApiError } from './api';

export interface SendFailure {
  line: string;
  details: string | null;
}

const LINE_MAX = 160;
const TECHNICAL = /(?:^|[\s'"(])(?:\/[^\s/'"]+){2,}|[A-Za-z]:\\|\bE[A-Z]{3,}\b/;

export const SEND_NOT_SENT = 'The reply was not sent. Send again to retry.';

export function sendFailure(cause: unknown): SendFailure {
  if (!(cause instanceof InboxApiError)) {
    const words = cause instanceof Error && cause.message ? cause.message : null;
    return { line: SEND_NOT_SENT, details: words && words !== SEND_NOT_SENT ? words : null };
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
  const details = words && cause.code !== 'upload_no_space' && words !== 'Internal error.' && words !== line ? words : null;
  return { line, details };
}
