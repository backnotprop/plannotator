/**
 * What an error toast says (design record "inbox-toasts-break-fixes"): the
 * Inbox's own sentence when the Inbox answered with one, plain words when it
 * did not answer at all, and the caller's fallback for anything else. Never a
 * browser's or a program's own words ("Failed to fetch", "Cannot read
 * properties of undefined"): those go to the console, not the toast.
 */
import { InboxApiError, InboxHeldError } from './api';
import type { InboxToastModel } from './components/Toast';

/** A fetch that never reached the Inbox (Chrome, Safari, Firefox each word it their own way). */
export const INBOX_UNREACHABLE = 'The Inbox did not answer. Try again in a moment.';

const NETWORK = /failed to fetch|load failed|networkerror|network request failed|network connection was lost/i;

/** The words for `cause`, or `fallback` when it has none fit to show. */
export function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof InboxApiError) return cause.message.trim() || fallback;
  if (cause instanceof Error && NETWORK.test(cause.message)) return INBOX_UNREACHABLE;
  // A program's own error (a TypeError, a SyntaxError from a garbled answer): its words mean nothing to the person.
  if (!(cause instanceof Error) || cause.name !== 'Error' || !cause.message.trim()) return fallback;
  return cause.message.trim();
}

/** The window's error toast for `cause` (a held write's clock toast too): what to do, its last sentence, always shows whole. */
export function errorToast(cause: unknown, fallback: string): Omit<InboxToastModel, 'id'> {
  // A write held for another machine did not fail: it waits in the outbox and says so, without the warning.
  if (cause instanceof InboxHeldError) return { icon: 'clock', lead: errorText(cause, fallback), wrap: true };
  const lead = errorText(cause, fallback);
  // What the toast does not say stays findable: the console has the cause itself.
  if (!(cause instanceof InboxApiError)) console.warn('[inbox] a write failed:', cause);
  return { icon: 'warn', lead, wrap: true };
}
