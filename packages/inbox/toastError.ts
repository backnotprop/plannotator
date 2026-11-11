/** A browser's or program's own words ("Failed to fetch", "Cannot read properties of undefined") never reach the toast; they go to the console. */
import { InboxApiError, InboxHeldError } from './api';
import type { InboxToastModel } from './components/Toast';

export const INBOX_UNREACHABLE = 'The Inbox did not answer. Try again in a moment.';

const NETWORK = /failed to fetch|load failed|networkerror|network request failed|network connection was lost/i;

export function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof InboxApiError) return cause.message.trim() || fallback;
  if (cause instanceof Error && NETWORK.test(cause.message)) return INBOX_UNREACHABLE;
  if (!(cause instanceof Error) || cause.name !== 'Error' || !cause.message.trim()) return fallback;
  return cause.message.trim();
}

export function errorToast(cause: unknown, fallback: string): Omit<InboxToastModel, 'id'> {
  if (cause instanceof InboxHeldError) return { icon: 'clock', lead: errorText(cause, fallback), wrap: true };
  const lead = errorText(cause, fallback);
  if (!(cause instanceof InboxApiError)) console.warn('[inbox] a write failed:', cause);
  return { icon: 'warn', lead, wrap: true };
}
