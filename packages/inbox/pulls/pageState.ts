/**
 * The state a PR's page shows (its mark, "Merged" or "Closed" beside it, and whether Post is offered), from the one
 * place that decides it. A page held open on a PR (keptStack.ts) hears of it from up to four places: the list, the
 * stack it held or drew last (its copy from when the list named it), its diff's read (`said`: merged or closed as the
 * forge said at that read, routePull.ts `forgeSaid`) and its own read of the PR (`read`, routePull.ts). Before, each
 * was laid over the next in turn, and a diff read that said closed outranked a list that named the PR open again
 * after a reopen: the page said Closed and hid Post.
 *
 * The order:
 * 1. Merged is final, whoever says it (a list lags a merge made elsewhere; nothing un-merges a PR).
 * 2. The list naming the PR: its word (a closed PR can reopen; the list reads the forge often).
 * 3. Else the page's own read of the PR, when the forge answered it now (`fresh`): newer than any diff read.
 * 4. Else the diff's read, merged or closed.
 * 5. Else the copy the server kept (the forge did not answer, or has no such PR now), when it is not open.
 * 6. Else the copy the page holds.
 *
 * Post (Approve with it) only on an open PR the forge still has: once it says it has no such PR (`missing`), the copy
 * shown is only its last read, and a review would go nowhere. The list naming it again is its word.
 */
import { inboxPullIsOpen, type InboxPull } from '@plannotator/core/inbox-types';

type State = Pick<InboxPull, 'state' | 'merged_at'>;

/** Where the page's state came from: the list, the copy held, the diff's read, the forge read now, the server's kept copy. */
export type PageStateSource = 'list' | 'held' | 'diff' | 'forge' | 'kept';

export interface PageStateInput {
  /** The layer as the page draws it: the list's when `listed`, else a held or drawn stack's, or the server's copy. */
  layer: State;
  /** The list names this PR. */
  listed: boolean;
  /** What the diff's read said of it, only merged or closed (`forgeSaid`). */
  said: State | null;
  /** The page's read of the PR itself while the list does not name it; `fresh` when that answer is the forge's now (or the list's). */
  read: { pull: State; fresh: boolean } | null;
  /** The forge answered that it has no such PR now (routePull.ts `missing`). */
  missing?: boolean;
}

/** Whether a page showing `shown` offers Post. */
export const pageOffersPost = (shown: Pick<InboxPull, 'state'>, listed: boolean, missing: boolean): boolean => inboxPullIsOpen(shown) && (listed || !missing);

export function pageState({ layer, listed, said, read, missing = false }: PageStateInput): State & { source: PageStateSource; post: boolean } {
  const of = (from: State, source: PageStateSource) => ({ state: from.state, merged_at: from.merged_at ?? null, source, post: pageOffersPost(from, listed, missing) });
  if (said?.state === 'merged') return of(said, 'diff');
  if (read?.pull.state === 'merged') return of(read.pull, read.fresh ? 'forge' : 'kept');
  if (layer.state === 'merged') return of(layer, listed ? 'list' : 'held');
  if (listed) return of(layer, 'list');
  if (read?.fresh) return of(read.pull, 'forge');
  if (said) return of(said, 'diff');
  if (read && !inboxPullIsOpen(read.pull)) return of(read.pull, 'kept');
  return of(layer, 'held');
}
