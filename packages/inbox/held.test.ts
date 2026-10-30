/**
 * The held list: only agent activity the person has not seen raises "N new".
 * If the person's own picks or replies counted, every action would raise a
 * notice; if a new agent message did not, the list would move under them.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { addOwnThreads, adoptKeepingOpen, drawnSection, heldNotice, markHeldRowArchived, putRowBack, refreshHeldRows, settleOwn, settlesOnBack, settleThread } from './held';

function row(id: string, project: string, last_at: string, last_author: 'agent' | 'person'): InboxListRow {
  return { thread_id: id, project: { id: `prj_${project}`, name: project }, last_at, last_author } as InboxListRow;
}

const sections = (...rows: InboxListRow[]): InboxListSection[] => [{ id: 'waiting', label: 'Waiting on you', threads: rows }];

describe('heldNotice', () => {
  test('a new thread and a newer agent message count; the person\'s own reply does not', () => {
    const shown = sections(row('a', 'billing-svc', '2026-10-07T10:00:00Z', 'agent'), row('b', 'docs-site', '2026-10-07T10:00:00Z', 'agent'));
    expect(heldNotice(shown, shown)).toEqual({ count: 0, text: null });
    const replied = sections(row('a', 'billing-svc', '2026-10-07T10:05:00Z', 'person'), row('b', 'docs-site', '2026-10-07T10:00:00Z', 'agent'));
    expect(heldNotice(shown, replied).count).toBe(0);
    const fresh = sections(
      row('a', 'billing-svc', '2026-10-07T10:00:00Z', 'agent'),
      row('b', 'docs-site', '2026-10-07T10:06:00Z', 'agent'),
      row('c', 'docs-site', '2026-10-07T10:07:00Z', 'agent'),
    );
    expect(heldNotice(shown, fresh)).toEqual({ count: 2, text: '2 new in docs-site' });
    const across = sections(...fresh[0]!.threads, row('d', 'billing-svc', '2026-10-07T10:08:00Z', 'agent'));
    expect(heldNotice(shown, across)).toEqual({ count: 3, text: '3 new' });
  });

  // The stress test of 2026-10-12, row 5: two projects named "api" (work and
  // personal) changed, and the notice said "2 new in api".
  test('two projects that share a name are two projects', () => {
    const work = (id: string, at: string) => ({ ...row(id, 'api', at, 'agent'), project: { id: 'prj_work', name: 'api' } }) as InboxListRow;
    const home = (id: string, at: string) => ({ ...row(id, 'api', at, 'agent'), project: { id: 'prj_home', name: 'api' } }) as InboxListRow;
    const shown = sections(work('a', '2026-10-07T10:00:00Z'));
    expect(heldNotice(shown, sections(work('a', '2026-10-07T10:00:00Z'), work('b', '2026-10-07T10:05:00Z'), home('c', '2026-10-07T10:06:00Z')))).toEqual({ count: 2, text: '2 new' });
    expect(heldNotice(shown, sections(work('a', '2026-10-07T10:00:00Z'), work('b', '2026-10-07T10:05:00Z')))).toEqual({ count: 1, text: '1 new in api' });
  });

  // The notice sits above rows that read the window's short name (projectLabels.ts): it names the project the same way.
  test('the notice names its project as the window does, the server name only for a project the window has no name for', () => {
    const repo = (id: string, at: string) => ({ ...row(id, 'x', at, 'agent'), project: { id: 'prj_repo', name: 'plannotator · plannotator' } }) as InboxListRow;
    const shown = sections(repo('a', '2026-10-07T10:00:00Z'));
    const latest = sections(repo('a', '2026-10-07T10:00:00Z'), repo('b', '2026-10-07T10:05:00Z'));
    expect(heldNotice(shown, latest, undefined, null, new Map([['prj_repo', 'plannotator']])).text).toBe('1 new in plannotator');
    expect(heldNotice(shown, latest, undefined, null, new Map()).text).toBe('1 new in plannotator · plannotator');
  });

  // The failure this guards: the Inbox's set-aside note is a person-authored
  // line, so an agent message followed by the note before the list read again
  // made the row's last message the person's, and the agent's message slipped
  // in without "N new".
  test("an agent message followed by the Inbox's note still counts; the note alone does not", () => {
    const shown = sections({ ...row('a', 'billing-svc', '2026-10-07T10:00:00Z', 'agent'), last_agent_at: '2026-10-07T10:00:00Z' } as InboxListRow);
    const noteOnly = sections({ ...row('a', 'billing-svc', '2026-10-07T10:00:10Z', 'person'), last_agent_at: '2026-10-07T10:00:00Z' } as InboxListRow);
    expect(heldNotice(shown, noteOnly).count).toBe(0);
    const agentThenNote = sections({ ...row('a', 'billing-svc', '2026-10-07T10:00:10Z', 'person'), last_agent_at: '2026-10-07T10:00:05Z' } as InboxListRow);
    expect(heldNotice(shown, agentThenNote)).toEqual({ count: 1, text: '1 new in billing-svc' });
  });

  // The failure this guards (inbox-replaced.spec.ts): the agent replaced a
  // question in the thread the person had open, the person then sent; counting
  // by last_agent_at alone made that replacement "1 new" on close, so the
  // notice the person pressed next was a stale one and a new thread stayed held.
  test('an agent message the person replied after is not news, on screen or not; a later agent message is', () => {
    const shown = sections({ ...row('a', 'billing-svc', '2026-10-12T10:00:00Z', 'agent'), last_agent_at: '2026-10-12T10:00:00Z', sent: null } as InboxListRow);
    const replacedThenSent = { ...row('a', 'billing-svc', '2026-10-12T10:02:00Z', 'person'), last_agent_at: '2026-10-12T10:01:00Z', sent: { at: '2026-10-12T10:02:00Z', checked_at: null } } as InboxListRow;
    expect(heldNotice(shown, sections(replacedThenSent)).count).toBe(0);
    expect(settleOwn(shown, sections(replacedThenSent))[0]!.threads[0]).toBe(replacedThenSent);
    // The same with a note after the reply: still the person's.
    const noteAfter = { ...replacedThenSent, last_at: '2026-10-12T10:03:00Z' } as InboxListRow;
    expect(heldNotice(shown, sections(noteAfter)).count).toBe(0);
    // The agent writes after the reply: news.
    const later = { ...row('a', 'billing-svc', '2026-10-12T10:04:00Z', 'agent'), last_agent_at: '2026-10-12T10:04:00Z', sent: null } as InboxListRow;
    expect(heldNotice(shown, sections(later))).toEqual({ count: 1, text: '1 new in billing-svc' });
    // Not on screen, a new thread beside it: only the new thread counts.
    const fresh = { ...row('b', 'billing-svc', '2026-10-12T10:05:00Z', 'agent'), last_agent_at: '2026-10-12T10:05:00Z', sent: null } as InboxListRow;
    expect(heldNotice(shown, sections(replacedThenSent, fresh))).toEqual({ count: 1, text: '1 new in billing-svc' });
  });

  // The failure this guards: a row not on screen counted as news whenever it
  // held any agent message, so a thread unarchived on the phone or in another
  // tab whose last real word is the person's (Sent, or Quiet once the agent
  // read the reply) raised "1 new" and stayed out of the list on settle.
  test("a row not on screen whose last real message is the person's is not news; one whose agent message is followed only by a note is", () => {
    const other = { ...row('other', 'docs-site', '2026-10-12T10:00:00Z', 'agent'), last_agent_at: '2026-10-12T10:00:00Z', sent: null, section: 'waiting', unseen: 1 } as InboxListRow;
    const shown: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [other] }];
    const replied = { ...row('replied', 'docs-site', '2026-10-12T11:00:00Z', 'person'), last_agent_at: '2026-10-12T09:00:00Z', section: 'sent', unseen: 0, sent: { at: '2026-10-12T11:00:00Z', checked_at: null } } as InboxListRow;
    const checked = { ...row('checked', 'docs-site', '2026-10-12T11:00:00Z', 'person'), last_agent_at: '2026-10-12T09:00:00Z', section: 'quiet', unseen: 0, sent: { at: '2026-10-12T11:00:00Z', checked_at: '2026-10-12T11:05:00Z' } } as InboxListRow;
    // The agent wrote, then the Inbox's note went: `sent` reads past the note, so it is null and the row is news.
    const noted = { ...row('noted', 'docs-site', '2026-10-12T11:10:00Z', 'person'), last_agent_at: '2026-10-12T11:09:00Z', section: 'new', unseen: 1, sent: null } as InboxListRow;
    const latest: InboxListSection[] = [
      { id: 'waiting', label: 'Waiting on you', threads: [other] },
      { id: 'new', label: 'New since you looked', threads: [noted] },
      { id: 'sent', label: 'Sent', threads: [replied] },
      { id: 'quiet', label: 'Quiet', threads: [checked] },
    ];
    expect(heldNotice(shown, latest)).toEqual({ count: 1, text: '1 new in docs-site' });
    const settled = settleOwn(shown, latest);
    expect(Object.fromEntries(settled.map((s) => [s.id, s.threads.map((t) => t.thread_id)]))).toEqual({ waiting: ['other'], new: [], sent: ['replied'], quiet: ['checked'] });
  });
});

describe('refreshHeldRows', () => {
  // The failure this guards: after the person's reply was delivered, the held
  // list kept the row's whole old state, so it said "Saved for <agent>" until
  // a reload while the thread beside it said "Delivered".
  test("a row's own state follows a delivery in place; the order and new agent activity stay held", () => {
    const sentRow = { ...row('a', 'billing-svc', '2026-10-07T10:05:00Z', 'person'), section: 'sent', sent: { at: '2026-10-07T10:05:00Z', checked_at: null } } as InboxListRow;
    const other = { ...row('b', 'docs-site', '2026-10-07T10:00:00Z', 'agent'), section: 'waiting' } as InboxListRow;
    const shown: InboxListSection[] = [
      { id: 'waiting', label: 'Waiting on you', threads: [other] },
      { id: 'sent', label: 'Sent', threads: [sentRow] },
    ];
    const delivered = { ...sentRow, section: 'quiet', sent: { at: sentRow.last_at, checked_at: '2026-10-07T10:06:00Z' } } as InboxListRow;
    const newer = { ...other, last_at: '2026-10-07T10:07:00Z', subject: 'A newer agent message' } as InboxListRow;
    const latest: InboxListSection[] = [
      { id: 'sent', label: 'Sent', threads: [] },
      { id: 'quiet', label: 'Quiet', threads: [newer, delivered] },
    ];

    const next = refreshHeldRows(shown, latest);
    // Same sections, same order on screen.
    expect(next.map((s) => s.id)).toEqual(['waiting', 'sent']);
    expect(next.map((s) => s.threads.map((r) => r.thread_id))).toEqual([['b'], ['a']]);
    // The delivered row shows its state as it now is.
    expect(next[1]!.threads[0]).toBe(delivered);
    // The row with a newer agent message keeps what was on screen, and still counts behind "N new".
    expect(next[0]!.threads[0]).toBe(other);
    expect(heldNotice(next, latest).count).toBe(1);
  });
});

describe('settleOwn', () => {
  const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, '0')}:00Z`;
  const r = (id: string, section: InboxListRow['section'], minute: number, last_author: 'agent' | 'person' = 'agent') =>
    ({ ...row(id, 'docs-site', at(minute), last_author), section }) as InboxListRow;
  const six = (by: Partial<Record<InboxListRow['section'], InboxListRow[]>>): InboxListSection[] =>
    (['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet'] as const).map((id) => ({ id, label: id, threads: by[id] ?? [] }));
  const ids = (sections: InboxListSection[]) => Object.fromEntries(sections.filter((s) => s.threads.length).map((s) => [s.id, s.threads.map((t) => t.thread_id)]));

  // The failure this guards: closing a thread brought in what agents did
  // while the person read (owner's decision 4: that waits for Show), or kept
  // the person's own reads where they were.
  test("the person's own reads and actions take their places; agent activity stays as it was on screen", () => {
    const shown = six({ new: [r('read', 'new', 5), r('next', 'new', 4)], stopped: [r('answered', 'stopped', 3)], waiting: [r('wrote', 'waiting', 2)] });
    const latest = six({
      // The look moved "read" to Quiet; the person's Send moved "answered" to Sent.
      quiet: [r('read', 'quiet', 5)],
      sent: [r('answered', 'sent', 6, 'person')],
      new: [r('next', 'new', 4)],
      // An agent wrote in "wrote" and started "fresh": both wait behind "N new".
      stopped: [r('fresh', 'stopped', 8), r('wrote', 'stopped', 7)],
    });
    const settled = settleOwn(shown, latest);
    expect(ids(settled)).toEqual({ waiting: ['wrote'], new: ['next'], sent: ['answered'], quiet: ['read'] });
    // The held row keeps the state that was on screen.
    expect(settled.find((s) => s.id === 'waiting')!.threads[0]!.last_at).toBe(at(2));
    expect(heldNotice(settled, latest)).toEqual({ count: 2, text: '2 new in docs-site' });
  });

  test("each section is in the list's order (newest first, ties on the id), with held rows among the rest", () => {
    const shown = six({ waiting: [r('b', 'waiting', 4), r('held', 'waiting', 3)] });
    const latest = six({ waiting: [r('a', 'waiting', 5, 'person'), r('b', 'waiting', 4), r('c', 'waiting', 4, 'person')], stopped: [r('held', 'stopped', 9)] });
    expect(ids(settleOwn(shown, latest))).toEqual({ waiting: ['a', 'b', 'c', 'held'] });
  });

  test('a thread gone from the store leaves; the section list is the latest one, empty sections included', () => {
    const shown = six({ new: [r('gone', 'new', 1), r('kept', 'new', 2)] });
    const latest = six({ new: [r('kept', 'new', 2)] });
    const settled = settleOwn(shown, latest);
    expect(settled.map((s) => s.id)).toEqual(['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet']);
    expect(ids(settled)).toEqual({ new: ['kept'] });
  });

  // The failure this guards: a thread archived while it was open (held in
  // place by markHeldRowArchived) stayed in the list after the close, or an
  // agent's message that brought it back from the archive came in with the
  // close instead of waiting behind "N new".
  test('a thread archived while open leaves at the settle; an agent bringing it back waits for Show', () => {
    const open = { ...r('archived', 'waiting', 3), resolved_at: null, unread: true } as InboxListRow;
    const other = { ...r('other', 'waiting', 2), resolved_at: null } as InboxListRow;
    const shown = markHeldRowArchived(six({ waiting: [open, other] }), 'archived', at(4));
    // The list the window reads leaves the archived thread out.
    expect(ids(settleOwn(shown, six({ waiting: [other] })))).toEqual({ waiting: ['other'] });
    // An agent wrote in it after the archive: it is back in the list, as news, which waits.
    const cameBack = { ...r('archived', 'new', 6), resolved_at: at(4), back_from_archive: true } as InboxListRow;
    const latest = six({ new: [cameBack], waiting: [other] });
    expect(ids(settleOwn(shown, latest))).toEqual({ waiting: ['other'] });
    expect(heldNotice(settleOwn(shown, latest), latest).count).toBe(1);
  });
});

describe('a thread the person brought back', () => {
  // The failure this guards: a thread the person unarchived from inside it
  // (or opened from a link) is not on screen and its last message is an
  // agent's, so it read as agent activity: "1 new" while open, and held out
  // of the list after the close until Show.
  test("a thread not on screen whose agent messages were all seen is the person's own: it settles in, and is no news", () => {
    const other = { ...row('other', 'docs-site', '2026-10-12T10:00:00Z', 'agent'), section: 'waiting', unseen: 1 } as InboxListRow;
    const back = { ...row('back', 'docs-site', '2026-10-12T09:00:00Z', 'agent'), section: 'waiting', unseen: 0 } as InboxListRow;
    const fresh = { ...row('fresh', 'docs-site', '2026-10-12T11:00:00Z', 'agent'), section: 'new', unseen: 1 } as InboxListRow;
    const shown: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [other] }];
    const latest: InboxListSection[] = [
      { id: 'waiting', label: 'Waiting on you', threads: [other, back] },
      { id: 'new', label: 'New since you looked', threads: [fresh] },
    ];
    const here = new Set(['back']);
    expect(heldNotice(shown, latest, here)).toEqual({ count: 1, text: '1 new in docs-site' });
    expect(settleOwn(shown, latest, here).map((s) => s.threads.map((t) => t.thread_id))).toEqual([['other', 'back'], []]);
  });

  // The failure this guards: the exemption reached threads this tab never
  // showed, so a thread an agent started and the person read on their phone
  // dropped out of "N new" while its row was still not on screen.
  test('an agent starts a thread and it is read elsewhere (unseen 0): this tab still shows 1 new, and the close leaves it for Show', () => {
    const other = { ...row('other', 'docs-site', '2026-10-12T10:00:00Z', 'agent'), section: 'waiting', unseen: 1 } as InboxListRow;
    const readOnPhone = { ...row('phone', 'docs-site', '2026-10-12T11:00:00Z', 'agent'), section: 'quiet', unseen: 0 } as InboxListRow;
    const shown: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [other] }];
    const latest: InboxListSection[] = [
      { id: 'waiting', label: 'Waiting on you', threads: [other] },
      { id: 'quiet', label: 'Quiet', threads: [readOnPhone] },
    ];
    expect(heldNotice(shown, latest, new Set(['other']))).toEqual({ count: 1, text: '1 new in docs-site' });
    expect(settleOwn(shown, latest, new Set(['other'])).map((s) => s.threads.map((t) => t.thread_id))).toEqual([['other'], []]);
  });
});

describe('markHeldRowArchived', () => {
  // The failure this guards: the window's list leaves archived threads out, so
  // refreshHeldRows keeps a row whose thread was just archived as it was (bold,
  // "Waiting") for as long as the person stays in the thread.
  test('the archived row shows archived in place; the others and the order stay; the next list read keeps it', () => {
    const a = { ...row('a', 'billing-svc', '2026-10-07T10:00:00Z', 'agent'), section: 'waiting', unread: true, resolved_at: null } as InboxListRow;
    const b = { ...row('b', 'docs-site', '2026-10-07T09:00:00Z', 'agent'), section: 'waiting', unread: true, resolved_at: null } as InboxListRow;
    const marked = markHeldRowArchived(sections(a, b), 'a', '2026-10-07T10:30:00Z');
    expect(marked[0]!.threads.map((r) => r.thread_id)).toEqual(['a', 'b']);
    expect(marked[0]!.threads[0]).toMatchObject({ resolved_at: '2026-10-07T10:30:00Z', section: 'quiet', unread: false });
    expect(marked[0]!.threads[1]).toBe(b);
    // The next read of the list (archived left out) keeps it as shown.
    expect(refreshHeldRows(marked, sections(b))[0]!.threads[0]).toBe(marked[0]!.threads[0]);
    // Unarchived again: the list has it, and its fresh state replaces the archived one.
    expect(refreshHeldRows(marked, sections(a, b))[0]!.threads[0]).toBe(a);
  });
});

// A new message in the thread the person has open (design record
// "inbox-new-in-open-thread", approved 2026-10-12): the open thread's row
// tells its state in place and is never in "N new"; on close it settles where
// its state puts it, an unseen arrival bringing it back unread.
describe('the open thread', () => {
  const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, '0')}:00Z`;
  const r = (id: string, project: string, minute: number, section: InboxListRow['section'], unseen: number) =>
    ({ ...row(id, project, at(minute), 'agent'), last_agent_at: at(minute), sent: null, section, unseen, unread: section !== 'quiet' && section !== 'sent' }) as InboxListRow;
  const bySection = (...rows: InboxListRow[]): InboxListSection[] =>
    (['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet'] as const).map((id) => ({ id, label: id, threads: rows.filter((x) => x.section === id) }));
  const ids = (list: InboxListSection[]) => list.filter((s) => s.threads.length > 0).map((s) => `${s.id}:${s.threads.map((t) => t.thread_id).join(',')}`);

  // Opened from New: the look unbolded it on screen, in place. Then the agent posts in it.
  const openShown = { ...r('open', 'billing-svc', 1, 'new', 0), unread: false } as InboxListRow;
  const other = r('other', 'docs-site', 0, 'new', 1);
  const shown = bySection(openShown, other);
  const arrived = r('open', 'billing-svc', 5, 'new', 1);
  const asked = r('open', 'billing-svc', 5, 'waiting', 1);
  const seen = r('open', 'billing-svc', 5, 'quiet', 0);
  const elsewhere = r('elsewhere', 'docs-site', 6, 'new', 1);
  /** The thread open now; and as it stood when it closed (what arrived while open is its own business, nothing after). */
  const OPEN = { threadId: 'open' };
  const closedAs = (asOf: InboxListRow | null) => ({ threadId: 'open', asOf });

  test('an arrival in the open thread is never in "N new"; another thread\'s still is, and the line names only that one', () => {
    expect(heldNotice(shown, bySection(arrived, other), undefined, OPEN)).toEqual({ count: 0, text: null });
    expect(heldNotice(shown, bySection(arrived, other, elsewhere), undefined, OPEN)).toEqual({ count: 1, text: '1 new in docs-site' });
    // Without the exemption (no thread open), the same arrival is news as before.
    expect(heldNotice(shown, bySection(arrived, other)).count).toBe(1);
  });

  test('the open thread\'s row goes bold in place on arrival and unbolds in place once seen; it never moves', () => {
    const onArrival = refreshHeldRows(shown, bySection(asked, other, elsewhere), OPEN);
    expect(ids(onArrival)).toEqual(['new:open,other']);
    expect(onArrival.find((s) => s.id === 'new')!.threads[0]).toBe(asked);
    expect(onArrival.find((s) => s.id === 'new')!.threads[0]).toMatchObject({ unread: true, unseen: 1 });
    const onSeen = refreshHeldRows(onArrival, bySection(seen, other, elsewhere), OPEN);
    expect(ids(onSeen)).toEqual(['new:open,other']);
    expect(onSeen.find((s) => s.id === 'new')!.threads[0]).toMatchObject({ unread: false, unseen: 0 });
    // Without the exemption the arrival waits behind "N new": the row keeps what it showed.
    expect(refreshHeldRows(shown, bySection(asked, other)).find((s) => s.id === 'new')!.threads[0]).toBe(openShown);
  });

  test('closed before the arrival was seen: it settles unread, in New, or in Waiting when it asks', () => {
    expect(ids(settleOwn(shown, bySection(arrived, other), undefined, closedAs(arrived)))).toEqual(['new:open,other']);
    const settled = settleOwn(shown, bySection(asked, other, elsewhere), undefined, closedAs(asked));
    expect(ids(settled)).toEqual(['waiting:open', 'new:other']);
    expect(settled.find((s) => s.id === 'waiting')!.threads[0]).toMatchObject({ unread: true });
    // Another thread's agent activity still waits behind Show.
    expect(heldNotice(settled, bySection(asked, other, elsewhere))).toEqual({ count: 1, text: '1 new in docs-site' });
    // Without the exemption (the old rule) the unseen arrival waited behind Show and the row kept its old state.
    expect(ids(settleOwn(shown, bySection(asked, other)))).toEqual(['new:open,other']);
  });

  test('closed after the arrival was seen: it settles where its state puts it (Quiet)', () => {
    expect(ids(settleOwn(shown, bySection(seen, other), undefined, closedAs(seen)))).toEqual(['new:other', 'quiet:open']);
  });

  test('a thread opened from a link, not on screen: closed unseen, it comes in unread; nothing else an agent started does', () => {
    const away = bySection(other);
    expect(heldNotice(away, bySection(arrived, other), new Set(['open']), OPEN).count).toBe(0);
    expect(ids(settleOwn(away, bySection(arrived, other, elsewhere), new Set(['open']), closedAs(arrived)))).toEqual(['new:open,other']);
  });

  // The failure this guards (inbox-replaced.spec.ts): an agent message that
  // lands in the beat between the close and the settle was taken as part of
  // the open visit, so it skipped "1 new" and moved the row by itself.
  test('an agent message after the close is news like any other, in the beat before the list settles', () => {
    // Closed with nothing new (the row as on screen); then the agent asks in it.
    const atClose = { ...openShown, section: 'quiet', unseen: 0 } as InboxListRow;
    const onScreen = bySection({ ...atClose }, other);
    expect(heldNotice(onScreen, bySection(asked, other), undefined, closedAs(atClose))).toEqual({ count: 1, text: '1 new in billing-svc' });
    expect(refreshHeldRows(onScreen, bySection(asked, other), closedAs(atClose)).find((s) => s.id === 'quiet')!.threads[0]).toMatchObject({ unseen: 0 });
    expect(ids(settleOwn(onScreen, bySection(asked, other), undefined, closedAs(atClose)))).toEqual(['new:other', 'quiet:open']);
    // No row for it at the close (an older list): nothing is exempt.
    expect(heldNotice(onScreen, bySection(asked, other), undefined, closedAs(null)).count).toBe(1);
  });

  // The failure this guards: the person archived the thread they had open
  // and the agent answered in it before they closed it. The archive branch of
  // settleOwn dropped the row (waiting behind "N new"), so the reply they did
  // not see vanished from the list on close.
  test('archived while open, then the agent writes in it before the close: unseen, it settles back unread', () => {
    const open = { ...r('open', 'billing-svc', 1, 'new', 0), unread: false, resolved_at: null } as InboxListRow;
    const archivedShown = markHeldRowArchived(bySection(open, other), 'open', at(2));
    // The agent's reply brings it back from the archive while it is still open: the row tells it in place.
    const cameBack = { ...r('open', 'billing-svc', 4, 'new', 1), resolved_at: at(2), back_from_archive: true } as InboxListRow;
    const whileOpen = refreshHeldRows(archivedShown, bySection(cameBack, other), OPEN);
    expect(whileOpen.flatMap((s) => s.threads).find((t) => t.thread_id === 'open')).toBe(cameBack);
    expect(heldNotice(whileOpen, bySection(cameBack, other), undefined, OPEN).count).toBe(0);
    // Closed before seeing it: back in New, bold.
    const settled = settleOwn(whileOpen, bySection(cameBack, other), undefined, closedAs(cameBack));
    expect(ids(settled)).toEqual(['new:open,other']);
    expect(settled.find((s) => s.id === 'new')!.threads[0]).toMatchObject({ unread: true, unseen: 1 });
    // The same reply after the close (the row at the close was the archived one): it waits behind "N new".
    const archivedAtClose = archivedShown.flatMap((s) => s.threads).find((t) => t.thread_id === 'open')!;
    expect(ids(settleOwn(archivedShown, bySection(cameBack, other), undefined, closedAs(archivedAtClose)))).toEqual(['new:other']);
  });

  test('settleThread (the list the thread covered): only that row moves, to its place in the section its state gives it', () => {
    const quietOpen = r('open', 'billing-svc', 1, 'quiet', 0);
    const q2 = r('q2', 'docs-site', 9, 'quiet', 0);
    const w1 = r('w1', 'docs-site', 7, 'waiting', 1);
    const w2 = r('w2', 'docs-site', 3, 'waiting', 1);
    const before = bySection(quietOpen, q2, w1, w2, other);
    const moved = settleThread(before, bySection(asked, q2, w1, w2, other, elsewhere), 'open');
    // Newest first in Waiting: w1 (10:07), open (10:05), w2 (10:03). The new thread `elsewhere` stays out.
    expect(ids(moved)).toEqual(['waiting:w1,open,w2', 'new:other', 'quiet:q2']);
    expect(moved.find((s) => s.id === 'new')!.threads[0]).toBe(other);
    // No row for it in the list read: nothing changes.
    expect(ids(settleThread(before, bySection(q2), 'open'))).toEqual(ids(before));
  });

  // The owner, 2026-10-27: "Why is this thread showing up in quiet? ... it has open questions". The questions
  // arrived while the thread was open (or the list was held) and were seen, so `unseen` was 0 and Back left
  // the row drawn in Quiet, its state Holding.
  test('settlesOnBack (the list the thread covered): an unseen arrival moves the row; so does waiting on the person while drawn elsewhere; a row only read stays as left', () => {
    const quietOpen = r('open', 'billing-svc', 1, 'quiet', 0);
    const drawnQuiet = bySection(quietOpen, other);
    const holdsSeen = r('open', 'billing-svc', 5, 'holding', 0);
    expect(settlesOnBack(drawnQuiet, holdsSeen)).toBe(true);
    expect(settlesOnBack(drawnQuiet, { ...holdsSeen, section: 'stopped' })).toBe(true);
    expect(settlesOnBack(drawnQuiet, { ...holdsSeen, section: 'waiting' })).toBe(true);
    expect(ids(settleThread(drawnQuiet, bySection(holdsSeen, other), 'open'))).toEqual(['holding:open', 'new:other']);
    // Already drawn where it waits: it stays as left.
    expect(settlesOnBack(bySection({ ...quietOpen, section: 'holding' }, other), holdsSeen)).toBe(false);
    // Only read (no agent activity, state Quiet), drawn in New where it was opened: as left.
    expect(settlesOnBack(shown, seen)).toBe(false);
    // An arrival not seen: it comes back unread, as before.
    expect(settlesOnBack(shown, arrived)).toBe(true);
  });
});

// The failure this guards (the owner, 2026-10-16: "When I create a new thread
// and hit send, why doesn't it show up in the Sent list?"): with a thread open
// the held list took no new row, so the thread the person had just started
// was missing from the list until they closed the one they were reading.
describe('addOwnThreads', () => {
  const at = (minute: number) => `2026-10-16T22:${String(minute).padStart(2, '0')}:00Z`;
  const r = (id: string, section: InboxListRow['section'], minute: number, last_author: 'agent' | 'person' = 'agent') =>
    ({ ...row(id, 'plannotator', at(minute), last_author), section }) as InboxListRow;
  const bySection = (...rows: InboxListRow[]): InboxListSection[] =>
    (['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet'] as const).map((id) => ({ id, label: id, threads: rows.filter((t) => t.section === id) }));
  const ids = (list: InboxListSection[]) => list.filter((s) => s.threads.length > 0).map((s) => `${s.id}:${s.threads.map((t) => t.thread_id).join(',')}`);

  test('the thread the person started goes into Sent at its place; every other row keeps its section and order; agent news still waits', () => {
    const waiting = r('w', 'waiting', 1);
    const sentOld = r('s1', 'sent', 2, 'person');
    const quiet = r('q', 'quiet', 3);
    const shown = bySection(waiting, sentOld, quiet);
    const mine = r('mine', 'sent', 9, 'person');
    // Meanwhile an agent started a thread and the waiting row moved: neither is the person's own, both stay held.
    const agentNew = r('agent', 'new', 8);
    const latest = bySection(mine, agentNew, r('s1', 'sent', 2, 'person'), r('w', 'quiet', 1), quiet);
    const next = addOwnThreads(shown, latest, ['mine']);
    expect(ids(next)).toEqual(['waiting:w', 'sent:mine,s1', 'quiet:q']);
    expect(next.find((s) => s.id === 'sent')!.threads[0]).toBe(mine);
    expect(heldNotice(next, latest).count).toBe(1);
  });

  test('a thread already on screen, or not in the list read, changes nothing', () => {
    const shown = bySection(r('s1', 'sent', 2, 'person'));
    const again = addOwnThreads(shown, bySection(r('s1', 'sent', 5, 'person')), ['s1']);
    expect(ids(again)).toEqual(['sent:s1']);
    expect(again.find((s) => s.id === 'sent')!.threads[0]).toBe(shown.find((s) => s.id === 'sent')!.threads[0]);
    expect(ids(addOwnThreads(shown, bySection(), ['gone']))).toEqual(['sent:s1']);
  });
});

// Click Inbox to refresh: a refresh beside an open thread adopts everything,
// but the open thread's row stays in the group it is drawn in, so the
// selection never goes into folded Quiet out of view.
describe('adoptKeepingOpen', () => {
  const two = (newRows: InboxListRow[], quiet: InboxListRow[]): InboxListSection[] => [
    { id: 'new', label: 'New since you looked', threads: newRows },
    { id: 'quiet', label: 'Quiet', threads: quiet },
  ];
  const at = (id: string, time: string, section: 'new' | 'quiet') => ({ ...row(id, 'docs', time, 'agent'), section }) as InboxListRow;

  test('the open row keeps its group, at its place there; everything else is the read', () => {
    // On screen: a is open (already read, so its own section says quiet), b new.
    const shown = two([at('a', '2026-10-20T10:00:00Z', 'quiet'), at('b', '2026-10-20T09:00:00Z', 'new')], []);
    // The read: c arrived, a is in Quiet.
    const latest = two([at('c', '2026-10-20T11:00:00Z', 'new'), at('b', '2026-10-20T09:00:00Z', 'new')], [at('a', '2026-10-20T10:00:00Z', 'quiet')]);
    const next = adoptKeepingOpen(shown, latest, 'a');
    expect(next[0]!.threads.map((r) => r.thread_id)).toEqual(['c', 'a', 'b']);
    expect(next[1]!.threads).toEqual([]);
  });

  test('without the open row on screen it is the read', () => {
    const latest = two([at('c', '2026-10-20T11:00:00Z', 'new')], [at('a', '2026-10-20T10:00:00Z', 'quiet')]);
    expect(adoptKeepingOpen(two([], []), latest, 'a')).toEqual(latest);
  });

  test('it keeps its place between the same neighbours, never re-sorted by its time', () => {
    // On screen a sits between x and y, though its time is older than y's (held rows keep their places).
    const shown = two([at('x', '2026-10-20T12:00:00Z', 'new'), at('a', '2026-10-20T08:00:00Z', 'quiet'), at('y', '2026-10-20T10:00:00Z', 'new')], []);
    const latest = two([at('x', '2026-10-20T12:00:00Z', 'new'), at('y', '2026-10-20T10:00:00Z', 'new')], [at('a', '2026-10-20T08:00:00Z', 'quiet')]);
    expect(adoptKeepingOpen(shown, latest, 'a')[0]!.threads.map((r) => r.thread_id)).toEqual(['x', 'a', 'y']);
  });

  // The window reads without archived threads: a thread the person archived while it is open is
  // not in the read, and its row (drawn Archived by markHeldRowArchived) must not vanish under them.
  test('an open thread the read leaves out (archived while open) stays as drawn, still Archived', () => {
    const archivedRow = { ...at('a', '2026-10-20T10:00:00Z', 'quiet'), resolved_at: '2026-10-20T10:05:00Z' } as InboxListRow;
    const shown = two([at('b', '2026-10-20T11:00:00Z', 'new'), archivedRow, at('c', '2026-10-20T09:00:00Z', 'new')], []);
    const latest = two([at('d', '2026-10-20T12:00:00Z', 'new'), at('b', '2026-10-20T11:00:00Z', 'new'), at('c', '2026-10-20T09:00:00Z', 'new')], []);
    const next = adoptKeepingOpen(shown, latest, 'a');
    expect(next[0]!.threads.map((r) => r.thread_id)).toEqual(['d', 'b', 'a', 'c']);
    expect(next[0]!.threads[2]).toBe(archivedRow);
    expect(next[0]!.threads[2]!.resolved_at).toBe('2026-10-20T10:05:00Z');
  });
});

describe('putRowBack (Undo of Mark read on a seen update held in New)', () => {
  const two = (newRows: InboxListRow[], quiet: InboxListRow[]): InboxListSection[] => [
    { id: 'new', label: 'New since you looked', threads: newRows },
    { id: 'quiet', label: 'Quiet', threads: quiet },
  ];
  const at = (id: string, time: string, section: 'new' | 'quiet') => ({ ...row(id, 'docs', time, 'agent'), section }) as InboxListRow;

  test('Mark read moved it to Quiet; Undo puts it back between the same neighbours, the rest as on screen', () => {
    // Held: a was read (its state says Quiet) and sits between x and y, out of time order.
    const before = two([at('x', '2026-10-20T12:00:00Z', 'new'), at('a', '2026-10-20T08:00:00Z', 'quiet'), at('y', '2026-10-20T10:00:00Z', 'new')], []);
    const latest = two([at('x', '2026-10-20T12:00:00Z', 'new'), at('y', '2026-10-20T10:00:00Z', 'new')], [at('a', '2026-10-20T08:00:00Z', 'quiet')]);
    expect(drawnSection(before, 'a')).toBe('new');
    const moved = settleThread(before, latest, 'a');
    expect(drawnSection(moved, 'a')).toBe('quiet');
    const back = putRowBack(moved, before, 'a');
    expect(back[0]!.threads.map((r) => r.thread_id)).toEqual(['x', 'a', 'y']);
    expect(back[1]!.threads).toEqual([]);
  });

  test('a row no longer on screen stays out', () => {
    const before = two([at('a', '2026-10-20T08:00:00Z', 'quiet')], []);
    const gone = two([], []);
    expect(putRowBack(gone, before, 'a')).toEqual(gone);
    expect(drawnSection(gone, 'a')).toBeNull();
    expect(drawnSection(null, 'a')).toBeNull();
  });
});
