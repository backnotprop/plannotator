/**
 * The one rule for the state a PR's page shows (pageState.ts), as a table. What regresses: a closed PR reopened since
 * its diff was read saying Closed with no Post while the list names it open (the diff's word laid over the list's); a
 * merge said by any read lost to an older open one; the page's own fresh read of a PR no list names losing to a diff
 * read from before it; the server's kept copy (the forge silent) outranking a fresh answer; Post offered on a PR the
 * forge says it has no such of (`missing`: the copy shown is only its last read).
 */
import { expect, test } from 'bun:test';
import { inboxPullIsOpen, type InboxPull } from '@plannotator/core/inbox-types';
import { pageState, type PageStateInput, type PageStateSource } from './pageState';

type State = InboxPull['state'];
const s = (state: State): Pick<InboxPull, 'state' | 'merged_at'> => ({ state, merged_at: state === 'merged' ? '2026-11-25T10:00:00Z' : null });

const rows: { why: string; layer: State; listed: boolean; said: State | null; read: [State, boolean] | null; missing?: true; post?: boolean; want: [State, PageStateSource] }[] = [
  { why: 'listed, nothing else said', layer: 'open', listed: true, said: null, read: null, want: ['open', 'list'] },
  { why: 'reopened: listed open again, the diff read before said closed', layer: 'open', listed: true, said: 'closed', read: null, want: ['open', 'list'] },
  { why: 'merged as the diff read it while the search still lists it open', layer: 'open', listed: true, said: 'merged', read: null, want: ['merged', 'diff'] },
  { why: 'the list says merged', layer: 'merged', listed: true, said: null, read: null, want: ['merged', 'list'] },
  { why: 'left the list, the forge answered merged now', layer: 'open', listed: false, said: null, read: ['merged', true], want: ['merged', 'forge'] },
  { why: 'left the list, reopened: the forge answered open now, the diff read before said closed', layer: 'closed', listed: false, said: 'closed', read: ['open', true], want: ['open', 'forge'] },
  { why: 'left the list, closed: the forge answered closed now', layer: 'open', listed: false, said: null, read: ['closed', true], want: ['closed', 'forge'] },
  { why: 'left the list, the forge silent: the diff read said closed, the kept copy open', layer: 'open', listed: false, said: 'closed', read: ['open', false], want: ['closed', 'diff'] },
  { why: 'left the list, the forge silent, the kept copy merged', layer: 'open', listed: false, said: null, read: ['merged', false], want: ['merged', 'kept'] },
  { why: 'left the list, the forge silent, the kept copy closed', layer: 'open', listed: false, said: null, read: ['closed', false], want: ['closed', 'kept'] },
  { why: 'left the list, the forge silent, the kept copy open: the held copy stands', layer: 'draft', listed: false, said: null, read: ['open', false], want: ['draft', 'held'] },
  { why: 'held merged; an older read still open never un-merges it', layer: 'merged', listed: false, said: null, read: ['open', true], want: ['merged', 'held'] },
  { why: 'not asked yet: the held copy', layer: 'open', listed: false, said: null, read: null, want: ['open', 'held'] },
  { why: 'left the list, the forge has no such PR now: the held copy shows, open, with no Post', layer: 'open', listed: false, said: null, read: ['open', false], missing: true, post: false, want: ['open', 'held'] },
  { why: 'listed again after the forge said missing: the list names it open, Post back', layer: 'open', listed: true, said: null, read: null, missing: true, post: true, want: ['open', 'list'] },
];

for (const row of rows) {
  test(row.why, () => {
    const input: PageStateInput = { layer: s(row.layer), listed: row.listed, said: row.said ? s(row.said) : null, read: row.read ? { pull: s(row.read[0]), fresh: row.read[1] } : null, missing: row.missing ?? false };
    const got = pageState(input);
    expect([got.state, got.source]).toEqual(row.want);
    expect(got.merged_at !== null).toBe(row.want[0] === 'merged');
    // Post (and Approve with it) only on an open PR the forge still has.
    expect(got.post).toBe(row.post ?? inboxPullIsOpen({ state: row.want[0] }));
  });
}
