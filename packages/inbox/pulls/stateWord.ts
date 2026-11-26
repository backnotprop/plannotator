/**
 * A PR's state in words, as its Reviews row says it ("Merged" or "Closed" before its number, ReviewRow.tsx). A page
 * held open on a PR that merged or closed says it the same way beside its mark (the owner, 2026-11-23: a merged or
 * closed pull request keeps its page and says in place what changed): the diff's header, a phone's too, and the
 * launchpad's facts.
 */
import type { InboxPull } from '@plannotator/core/inbox-types';

export const PULL_STATE_WORD: Record<InboxPull['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

/** "Merged" or "Closed" for a PR that is no longer open; null for an open or draft one. */
export const shutWord = (state: InboxPull['state']): string | null => (state === 'merged' || state === 'closed' ? PULL_STATE_WORD[state] : null);
