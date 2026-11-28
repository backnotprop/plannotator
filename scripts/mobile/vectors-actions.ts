/**
 * The acts suite: the words the window says after a row action, run over the
 * rows fixture and a small fixture of its own (bulk outcomes, long agent names,
 * addresses). scripts/mobile/vectors.ts writes vectors/acts.json from it.
 *
 * What the app's conformance tests hold to: Mark read's and Mark unread's
 * toasts at each place, the warning before a Mark read that sets questions
 * aside, a bulk action's one toast (some refused, some held), the short agent
 * name a one-line place takes, and the address Copy link copies.
 */
import { shortAgentName } from '../../packages/core/inbox-format';
import type { InboxListRow } from '../../packages/core/inbox-types';
import { InboxApiError } from '../../packages/inbox/api';
import { bulkToast } from '../../packages/inbox/bulkWrites';
import { markReadToast, markUnreadToast, setAsideCount, setAsideWarning, type MarkReadPlace } from '../../packages/inbox/markRead';
import { threadLink } from '../../packages/inbox/rowMenu';
import type { BulkAction } from '../../packages/inbox/rowPicks';
import { INBOX_UNREACHABLE } from '../../packages/inbox/toastError';
import { readRepoText } from './lib';

export const ACTS_FIXTURE = 'apps/mobile/contract/fixtures/acts.json';
export const ACTS_ROWS = 'apps/mobile/contract/fixtures/rows.json';

type Fixture = {
  names: string[];
  links: { thread_id: string; url: string | null; via: 'local' | 'tailnet' | null; origin: string }[];
  bulk: { action: BulkAction; made: number; held: number; held_on: string[]; refused: number; refusal: string | null; detail: string | null }[];
  set_aside: { questions: number; actions: number; threads: number }[];
};

const PLACES: MarkReadPlace[] = ['open', 'held', 'list'];

export function actVectors(about: string): unknown {
  const fixture = JSON.parse(readRepoText(ACTS_FIXTURE)) as Fixture;
  const rows = (JSON.parse(readRepoText(ACTS_ROWS)) as { rows: (InboxListRow & { note?: string })[] }).rows.map(({ note: _note, ...row }) => row as InboxListRow);
  const row = rows[0]!;
  return {
    about,
    unreachable: INBOX_UNREACHABLE,
    rows: rows.map((r) => ({
      thread_id: r.thread_id,
      mark_read: Object.fromEntries(PLACES.map((place) => [place, markReadToast(r, place)])),
      mark_unread: { stays: markUnreadToast(r, false), moved: markUnreadToast(r, true) },
      set_aside: setAsideWarning(setAsideCount([r]), false),
    })),
    set_aside: fixture.set_aside.map((count) => ({ count, one: setAsideWarning(count, false), bulk: setAsideWarning(count, true) })),
    bulk: fixture.bulk.map((c) => {
      // The outcomes a bulk write makes: made (some of them held for a machine that is away), then refused.
      const outcomes = [
        ...Array.from({ length: c.made }, (_, i) => ({ row, ok: true as const, value: undefined, held: i < c.held ? (c.held_on[i % Math.max(1, c.held_on.length)] ?? 'the other machine') : null })),
        ...Array.from({ length: c.refused }, () => ({ row, ok: false as const, cause: c.refusal === null ? new Error('') : new InboxApiError(409, 'refused', c.refusal) })),
      ];
      return { ...c, toast: bulkToast(c.action, outcomes, c.detail ?? undefined) };
    }),
    names: fixture.names.map((name) => ({ name, short: shortAgentName(name) })),
    links: fixture.links.map((c) => ({ ...c, link: threadLink(c.thread_id, c.via ? { url: c.url, via: c.via } : null, c.origin) })),
  };
}
