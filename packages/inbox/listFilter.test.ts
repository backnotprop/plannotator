/**
 * The list's filter rule (listFilter.ts): which rows the list keeps for a set of picks, the badge's count, what a
 * project's page keeps, the menu's counts and the remembered cookie.
 *
 * What this catches: a group that ORs where it should AND (or the reverse inside a group); a day span off by one at
 * midnight, at the 7th or 30th day back, or at a range's last day; an agent missed when the thread has several or was
 * started by the person; a project's page that still applies the Project picks; Smart groups reordered or renamed by
 * the filter; a menu count that applies its own group; a cookie that keeps junk or breaks the list; a Pull request
 * pick that reads the wrong state, treats a removed PR as one, or puts a PR not read yet under a state (or under No PR);
 * a Not seen that reads anything but the row's bold (`unread`), a row the person opened that a Not seen list drops, or
 * a cookie from before Not seen that no longer loads. Tags (approval "inbox-thread-tags", step 2): several tags that
 * AND instead of OR, a Tag pick that ignores the other groups, a row's tags read past the window's rule (an older
 * linked machine's), a tag's list that still applies Tag picks, a pick whose tag moved to another machine's id or was
 * deleted. Routines: a Routine pick that keeps a linked machine's thread of the same id, applies while Routines are
 * off, counts in the badge while off, or a cookie that keeps a pick it does not know.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { inboxThreadPullsSummary, type InboxListRow, type InboxListSection, type InboxThreadPull, type InboxThreadPullState } from '@plannotator/core/inbox-types';
import {
  LIST_FILTER_COOKIE,
  NO_LIST_FILTER,
  appliedFilter,
  countWhere,
  filterListSections,
  parseListFilter,
  pickCount,
  resetListFilterForTests,
  rowMatches,
  rowPullMatches,
  rowPullStates,
  rowNotSeen,
  settledHeldRead,
  writeListFilter,
  type ListFilter,
} from './listFilter';
import { toggledTagPick, withLiveTagPicks } from './listFilterTags';
import { routineHold, routineThreadTest, routineThreadsState } from './listFilterRoutines';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { clearedFrom } from './components/ListFilter';
import { setStorageBackend, resetStorageBackend, getItem } from '@plannotator/ui/utils/storage';

/** Local times, so the spans read the window's own days. */
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).toISOString();
const NOW = new Date(2026, 10, 8, 12, 0).getTime(); // Nov 8, noon

type PullState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';
function row(id: string, extra: { project?: string; last_at?: string; host?: string; hosts?: string[]; addressee?: string; person?: boolean; pull?: PullState; pulls?: number; unread?: boolean } = {}): InboxListRow {
  const project = extra.project ?? 'billing';
  return {
    thread_id: id,
    project: { id: `prj_${project}`, name: project },
    last_at: extra.last_at ?? at(11, 8, 9),
    author: extra.person ? { kind: 'user' } : { kind: 'agent', host: extra.host ?? 'claude-code', session: `s_${id}`, name: null },
    participants: extra.hosts?.map((host, i) => ({ host, session: `s_${id}_${i}` })),
    addressee: extra.addressee ? { host: extra.addressee, session: 's_to', name: null } : null,
    // PR linking's row shape (InboxThreadPullsSummary): how many, and the PR its mark shows.
    pulls: extra.pull ? { count: extra.pulls ?? 1, headline: { key: `github.com/o/r#${id}`, state: extra.pull } } : undefined,
    unread: extra.unread ?? false,
  } as unknown as InboxListRow;
}

const ROWS = {
  billingToday: row('billingToday', { project: 'billing', last_at: at(11, 8, 0, 30), pull: 'open', unread: true }),
  webLateYesterday: row('webLateYesterday', { project: 'web', last_at: at(11, 7, 23, 30), host: 'codex', pull: 'draft', unread: true }),
  webSixDaysBack: row('webSixDaysBack', { project: 'web', last_at: at(11, 2, 0, 10), host: 'pi' }),
  docsSevenDaysBack: row('docsSevenDaysBack', { project: 'docs', last_at: at(11, 1, 23, 59), pull: 'merged', pulls: 3 }),
  docs29Back: row('docs29Back', { project: 'docs', last_at: at(10, 10, 8) }),
  opsOld: row('opsOld', { project: 'ops', last_at: at(10, 9, 8), host: 'codex', pull: 'closed' }),
  mixed: row('mixed', { project: 'ops', last_at: at(11, 5, 10), hosts: ['codex', 'pi'], pull: 'unknown', unread: true }),
  startedByPerson: row('startedByPerson', { project: 'web', last_at: at(11, 6, 10), person: true, addressee: 'pi' }),
};
const ALL = Object.values(ROWS);
const kept = (filter: Partial<ListFilter>) => ALL.filter((r) => rowMatches(r, { ...NO_LIST_FILTER, ...filter }, NOW)).map((r) => r.thread_id);

describe('which rows a set of picks keeps', () => {
  const cases: Array<[string, Partial<ListFilter>, string[]]> = [
    ['nothing picked: every row', {}, ALL.map((r) => r.thread_id)],
    ['one project', { projects: ['prj_web'] }, ['webLateYesterday', 'webSixDaysBack', 'startedByPerson']],
    ['two projects widen (either one)', { projects: ['prj_billing', 'prj_docs'] }, ['billingToday', 'docsSevenDaysBack', 'docs29Back']],
    ['Today starts at this midnight, not 24 hours back', { updated: 'today' }, ['billingToday']],
    ['Last 3 days includes the second day back and excludes the third', { updated: '3d' }, ['billingToday', 'webLateYesterday', 'startedByPerson']],
    ['Last 7 days is today and the six days before it', { updated: '7d' }, ['billingToday', 'webLateYesterday', 'webSixDaysBack', 'mixed', 'startedByPerson']],
    ['Last 30 days keeps the 29th day back, not the 30th', { updated: '30d' }, ['billingToday', 'webLateYesterday', 'webSixDaysBack', 'docsSevenDaysBack', 'docs29Back', 'mixed', 'startedByPerson']],
    ['a range keeps its whole last day', { updated: { from: '2026-11-01', to: '2026-11-02' } }, ['webSixDaysBack', 'docsSevenDaysBack']],
    ['a range picked backwards reads forwards', { updated: { from: '2026-11-02', to: '2026-11-01' } }, ['webSixDaysBack', 'docsSevenDaysBack']],
    ['one agent: its own threads and the threads it is one of several in', { agents: ['Codex'] }, ['webLateYesterday', 'opsOld', 'mixed']],
    ['a thread the person started counts as its addressee\'s', { agents: ['Pi'] }, ['webSixDaysBack', 'mixed', 'startedByPerson']],
    ['two agents widen', { agents: ['Claude Code', 'Pi'] }, ['billingToday', 'webSixDaysBack', 'docsSevenDaysBack', 'docs29Back', 'mixed', 'startedByPerson']],
    ['groups narrow each other (project and span and agent)', { projects: ['prj_web', 'prj_ops'], updated: '7d', agents: ['Codex'] }, ['webLateYesterday', 'mixed']],
    ['picks that leave nothing', { projects: ['prj_billing'], agents: ['Pi'] }, []],
  ];
  for (const [name, filter, ids] of cases) test(name, () => expect(kept(filter)).toEqual(ids));
});

describe('the Pull request group', () => {
  const cases: Array<[string, Partial<ListFilter>, string[]]> = [
    ['Open: the threads whose PR is open', { pulls: ['open'] }, ['billingToday']],
    ['Draft is not Open', { pulls: ['draft'] }, ['webLateYesterday']],
    ['Merged reads the PR the row shows, however many the thread has', { pulls: ['merged'] }, ['docsSevenDaysBack']],
    ['Closed', { pulls: ['closed'] }, ['opsOld']],
    ['two states widen', { pulls: ['open', 'draft'] }, ['billingToday', 'webLateYesterday']],
    ['Has a PR: any state, unread ones too', { pulls: ['any'] }, ['billingToday', 'webLateYesterday', 'docsSevenDaysBack', 'opsOld', 'mixed']],
    ['No PR: the threads with none', { pulls: ['none'] }, ['webSixDaysBack', 'docs29Back', 'startedByPerson']],
    ['No PR or Merged widen', { pulls: ['none', 'merged'] }, ['webSixDaysBack', 'docsSevenDaysBack', 'docs29Back', 'startedByPerson']],
    ['narrows with the other groups', { pulls: ['any'], agents: ['Codex'], updated: '7d' }, ['webLateYesterday', 'mixed']],
  ];
  for (const [name, filter, ids] of cases) test(name, () => expect(kept(filter)).toEqual(ids));

  test('the badge counts its picks and a menu row counts without its own group', () => {
    const filter: ListFilter = { ...NO_LIST_FILTER, pulls: ['open', 'none'], updated: '7d' };
    expect(pickCount(filter)).toBe(3);
    expect(countWhere(ALL, filter, NOW, 'pulls', (r) => rowPullStates(r).includes('draft'))).toBe(1);
  });

  test('a row with a count of none, or no pulls at all, has no PR', () => {
    expect(rowPullStates(row('gone', { pull: 'open', pulls: 0 }))).toEqual([]);
    expect(rowPullStates(row('never'))).toEqual([]);
  });
});

describe('Not seen', () => {
  test('keeps the rows drawn bold, and narrows with the other groups', () => {
    expect(kept({ notSeen: true })).toEqual(['billingToday', 'webLateYesterday', 'mixed']);
    expect(kept({ notSeen: true, agents: ['Codex'], updated: '7d' })).toEqual(['webLateYesterday', 'mixed']);
    expect(kept({ notSeen: true, projects: ['prj_docs'] })).toEqual([]);
  });

  test('reads the bold alone: a row still waiting on the person is seen once its news is', () => {
    expect(rowNotSeen({ ...row('waitingSeen'), section: 'waiting', unread: false } as InboxListRow)).toBe(false);
    expect(rowNotSeen({ ...row('newUnseen'), section: 'new', unread: true } as InboxListRow)).toBe(true);
  });

  test('the badge counts it once, and its menu row counts without itself', () => {
    const filter: ListFilter = { ...NO_LIST_FILTER, notSeen: true, projects: ['prj_web'] };
    expect(pickCount(filter)).toBe(2);
    expect(countWhere(ALL, filter, NOW, 'notSeen', rowNotSeen)).toBe(1);
  });

  test('a row held for it (opened while bold) stays when it stops matching; the other groups still apply', () => {
    const sections = [{ id: 'new', label: 'New since you looked', threads: [ROWS.webSixDaysBack, ROWS.docs29Back, ROWS.billingToday] }] as InboxListSection[];
    const ids = (filter: Partial<ListFilter>, held?: ReadonlySet<string>) => filterListSections(sections, { ...NO_LIST_FILTER, ...filter }, NOW, held)[0]!.threads.map((r) => r.thread_id);
    expect(ids({ notSeen: true })).toEqual(['billingToday']);
    expect(ids({ notSeen: true }, new Set(['webSixDaysBack']))).toEqual(['webSixDaysBack', 'billingToday']);
    expect(ids({ notSeen: true, projects: ['prj_billing'] }, new Set(['webSixDaysBack']))).toEqual(['billingToday']);
  });

  test('a settle lets go of every held row but the thread still open', () => {
    const held = new Set(['a', 'b']);
    expect([...settledHeldRead(held, 'b')]).toEqual(['b']);
    expect([...settledHeldRead(held, null)]).toEqual([]);
    expect([...settledHeldRead(held, 'c')]).toEqual([]);
    const one = new Set(['b']);
    expect(settledHeldRead(one, 'b')).toBe(one);
  });
});

test('a PR not read yet is kept by Has a PR alone: by no state, and never by No PR', () => {
  expect(rowPullStates(ROWS.mixed)).toEqual(['unknown']);
  expect((['open', 'draft', 'merged', 'closed', 'any', 'none'] as const).filter((pick) => rowPullMatches(ROWS.mixed, pick))).toEqual(['any']);
  expect(kept({ pulls: ['open', 'draft', 'merged', 'closed', 'none'] })).not.toContain('mixed');
});

test('the row summary the server builds is what the picks read: the PR still in play, else the one not read, else the last', () => {
  const pull = (n: number, state: InboxThreadPullState): InboxThreadPull => ({
    id: `thr:github.com/o/r#${n}`,
    project_id: 'prj',
    thread_id: 'thr',
    pull: `github.com/o/r#${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    added_by: { kind: 'person' },
    added_at: new Date(2026, 10, 1, n).toISOString(),
    state,
    title: null,
    base: null,
    head: null,
    read_at: null,
  });
  const picksOf = (pulls: InboxThreadPull[]) => {
    const r = { pulls: inboxThreadPullsSummary(pulls) };
    return (['open', 'draft', 'merged', 'closed', 'any', 'none'] as const).filter((pick) => rowPullMatches(r, pick));
  };
  expect(picksOf([])).toEqual(['none']);
  expect(picksOf([pull(1, 'merged'), pull(2, 'draft')])).toEqual(['draft', 'any']);
  expect(picksOf([pull(1, 'merged'), pull(2, 'unknown')])).toEqual(['any']);
  expect(picksOf([pull(1, 'merged'), pull(2, 'closed')])).toEqual(['closed', 'any']);
  expect(picksOf([pull(1, 'open')])).toEqual(['open', 'any']);
});

test('a project\'s page sets its Project picks aside, and the badge counts what applies', () => {
  const filter: ListFilter = { projects: ['prj_web', 'prj_docs'], updated: '7d', agents: ['Pi'], pulls: [], notSeen: false, tags: [], routines: [] };
  expect(pickCount(filter)).toBe(4);
  expect(appliedFilter(filter, true)).toEqual({ projects: [], updated: '7d', agents: ['Pi'], pulls: [], notSeen: false, tags: [], routines: [] });
  expect(pickCount(appliedFilter(filter, true))).toBe(2);
  expect(appliedFilter(filter, false)).toBe(filter);
});

test('Smart groups keep their order and names and count only the matches; nothing picked hands the same sections back', () => {
  const sections = [
    { id: 'waiting', label: 'Waiting on you', threads: [ROWS.billingToday, ROWS.webLateYesterday] },
    { id: 'new', label: 'New since you looked', threads: [ROWS.opsOld] },
    { id: 'quiet', label: 'Quiet', threads: [ROWS.webSixDaysBack, ROWS.docs29Back] },
  ] as InboxListSection[];
  expect(filterListSections(sections, NO_LIST_FILTER, NOW)).toBe(sections);
  const out = filterListSections(sections, { ...NO_LIST_FILTER, projects: ['prj_web'] }, NOW);
  expect(out.map((s) => [s.id, s.label, s.threads.map((r) => r.thread_id)])).toEqual([
    ['waiting', 'Waiting on you', ['webLateYesterday']],
    ['new', 'New since you looked', []],
    ['quiet', 'Quiet', ['webSixDaysBack']],
  ]);
});

test('a menu row counts with the other groups\' picks, not its own group\'s', () => {
  const filter: ListFilter = { projects: ['prj_web'], updated: '7d', agents: [], pulls: [], notSeen: false, tags: [], routines: [] };
  // docs is not picked, but its row says what ticking it would add: docs rows in the last 7 days.
  expect(countWhere(ALL, filter, NOW, 'projects', (r) => r.project.id === 'prj_docs')).toBe(0);
  expect(countWhere(ALL, filter, NOW, 'projects', (r) => r.project.id === 'prj_billing')).toBe(1);
  // Last 30 days, with web picked: web rows in 30 days.
  expect(countWhere(ALL, { ...filter, updated: 'today' }, NOW, 'updated', (r) => Date.parse(r.last_at) >= new Date(2026, 9, 10).getTime())).toBe(3);
});

describe('remembered per browser', () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
    resetListFilterForTests();
  });
  afterEach(() => {
    resetStorageBackend();
    resetListFilterForTests();
  });

  test('picks are written, read back, and removed when cleared', () => {
    const filter: ListFilter = { projects: ['prj_web'], updated: { from: '2026-10-20', to: '2026-11-01' }, agents: ['Codex'], pulls: ['merged', 'none'], notSeen: true, tags: ['ini_release'], routines: ['other'] };
    writeListFilter(filter);
    expect(parseListFilter(getItem(LIST_FILTER_COOKIE))).toEqual(filter);
    writeListFilter(NO_LIST_FILTER);
    expect(stored.has(LIST_FILTER_COOKIE)).toBe(false);
  });

  test('the saved three-day preset advances with the window clock', () => {
    const filter = parseListFilter(JSON.stringify({ updated: '3d' }));
    expect(rowMatches(ROWS.startedByPerson, filter, NOW)).toBe(true);
    expect(rowMatches(ROWS.startedByPerson, filter, new Date(2026, 10, 9).getTime())).toBe(false);
  });

  const junk: Array<[string, string | null, ListFilter]> = [
    ['no cookie', null, NO_LIST_FILTER],
    ['not JSON', '{oops', NO_LIST_FILTER],
    ['wrong shapes are dropped', JSON.stringify({ projects: 'prj_web', updated: 'yesterday', agents: [1, 'Pi', ''] }), { projects: [], updated: null, agents: ['Pi'], pulls: [], notSeen: false, tags: [], routines: [] }],
    ['unknown Pull request picks are dropped', JSON.stringify({ pulls: ['open', 'stale', 3] }), { ...NO_LIST_FILTER, pulls: ['open'] }],
    ['Not seen is on only for true', JSON.stringify({ notSeen: 'yes' }), NO_LIST_FILTER],
    ['a cookie from before Not seen loads with it off', JSON.stringify({ projects: ['prj_web'], updated: '7d', agents: [], pulls: ['open'] }), { ...NO_LIST_FILTER, projects: ['prj_web'], updated: '7d', pulls: ['open'] }],
    ['unknown Routine picks are dropped', JSON.stringify({ routines: ['routine', 'cron', 1] }), { ...NO_LIST_FILTER, routines: ['routine'] }],
    ['a cookie from before Routines loads with no Routine pick', JSON.stringify({ pulls: ['open'], tags: ['ini_release'] }), { ...NO_LIST_FILTER, pulls: ['open'], tags: ['ini_release'] }],
    ['a cookie from before tags loads with no Tag pick', JSON.stringify({ agents: ['Pi'], notSeen: true }), { ...NO_LIST_FILTER, agents: ['Pi'], notSeen: true }],
    // Recent activity was a pick once (0.29's cookie): now a view kept nowhere, so a saved `recent: true` opens no one's Inbox in it.
    ['a saved Recent activity pick is ignored', JSON.stringify({ recent: true }), NO_LIST_FILTER],
    ['a saved Recent activity pick beside real picks keeps only those', JSON.stringify({ recent: true, notSeen: true, pulls: ['open'] }), { ...NO_LIST_FILTER, notSeen: true, pulls: ['open'] }],
    ['a range with a bad day is dropped', JSON.stringify({ updated: { from: '2026-13', to: '2026-11-01' } }), NO_LIST_FILTER],
  ];
  for (const [name, raw, want] of junk) test(name, () => expect(parseListFilter(raw)).toEqual(want));
});

describe('Tag picks (approval "inbox-thread-tags", step 2)', () => {
  const tagged = (r: InboxListRow, tags: string[]) => ({ ...r, tags }) as InboxListRow;
  const T = {
    release: tagged(ROWS.billingToday, ['ini_release']),
    both: tagged(ROWS.webLateYesterday, ['ini_release', 'ini_windows']),
    windows: tagged(ROWS.opsOld, ['ini_windows']),
    none: ROWS.webSixDaysBack,
  };
  const ROWS_T = Object.values(T);
  const keptT = (filter: Partial<ListFilter>, tagsOf?: (row: InboxListRow) => readonly string[]) => ROWS_T.filter((r) => rowMatches(r, { ...NO_LIST_FILTER, ...filter }, NOW, undefined, tagsOf)).map((r) => r.thread_id);

  test('several tags widen the list; with another group they narrow it', () => {
    expect(keptT({ tags: ['ini_release'] })).toEqual(['billingToday', 'webLateYesterday']);
    expect(keptT({ tags: ['ini_release', 'ini_windows'] })).toEqual(['billingToday', 'webLateYesterday', 'opsOld']);
    expect(keptT({ tags: ['ini_release', 'ini_windows'], projects: ['prj_web'] })).toEqual(['webLateYesterday']);
    expect(keptT({ tags: ['ini_windows'], updated: '7d' })).toEqual(['webLateYesterday']);
    expect(pickCount({ ...NO_LIST_FILTER, tags: ['ini_release', 'ini_windows'], notSeen: true })).toBe(3);
  });

  test('a row\'s tags are read by the window\'s rule, not the row\'s own field', () => {
    // An older linked machine's row: the window reads no tags on it, so no Tag pick keeps it.
    expect(keptT({ tags: ['ini_release'] }, (r) => (r.thread_id === 'billingToday' ? [] : (r.tags ?? [])))).toEqual(['webLateYesterday']);
  });

  test('a Tag row counts with the other groups\' picks, not its own', () => {
    const filter: ListFilter = { ...NO_LIST_FILTER, tags: ['ini_windows'], projects: ['prj_billing', 'prj_web'] };
    expect(countWhere(ROWS_T, filter, NOW, 'tags', (r) => (r.tags ?? []).includes('ini_release'))).toBe(2);
    expect(countWhere(ROWS_T, filter, NOW, 'projects', (r) => r.project.id === 'prj_ops')).toBe(1);
  });

  test('on a tag\'s list the Tag picks step aside, and Clear filters keeps them for the Inbox', () => {
    const filter: ListFilter = { ...NO_LIST_FILTER, tags: ['ini_release'], agents: ['Pi'] };
    expect(appliedFilter(filter, false, true)).toEqual({ ...filter, tags: [] });
    expect(appliedFilter(filter, false, false)).toBe(filter);
    expect(clearedFrom(filter, false, true)).toEqual({ ...NO_LIST_FILTER, tags: ['ini_release'] });
    expect(clearedFrom({ ...filter, projects: ['prj_web'] }, true, true)).toEqual({ ...NO_LIST_FILTER, projects: ['prj_web'], tags: ['ini_release'] });
    expect(clearedFrom(filter, false)).toEqual(NO_LIST_FILTER);
  });

  test('a pick names its tag by any machine\'s id; a deleted tag\'s pick applies nothing; no tags kept, no Tag pick', () => {
    const release = { id: 'ini_here', name: 'Release', created_at: '', created_by: { kind: 'person' }, updated_at: '', deleted_at: null, machines: { self: 'ini_here', far: 'ini_far' } } as const;
    const live = [release];
    const filter: ListFilter = { ...NO_LIST_FILTER, tags: ['ini_far', 'ini_gone'] };
    expect(withLiveTagPicks(filter, live).tags).toEqual(['ini_here']);
    expect(pickCount(withLiveTagPicks(filter, live))).toBe(1);
    expect(withLiveTagPicks(filter, null).tags).toEqual([]);
    // The list not read yet: the picks hold as they are, so the rows never show unfiltered for a moment.
    expect(withLiveTagPicks(filter, undefined)).toBe(filter);
    const none = { ...NO_LIST_FILTER };
    expect(withLiveTagPicks(none, live)).toBe(none);
    // Unticking takes every pick that names it; ticking adds the list's id.
    expect(toggledTagPick(['ini_far', 'ini_gone'], release, live)).toEqual(['ini_gone']);
    expect(toggledTagPick([], release, live)).toEqual(['ini_here']);
  });
});

describe('Routine picks (Routine threads, Other threads)', () => {
  const OTHER = 'ibx_01HYYYYYYYYYYYYYYYYYYYYYYY';
  const routine = (thread_id: string | null) => ({ id: `sch_${thread_id}`, thread_id }) as unknown as InboxScheduledRow;
  // A routine runs in billingToday's and mixed's threads; one not run yet has no thread.
  const isRoutine = routineThreadTest([routine('billingToday'), routine('mixed'), routine(null)])!;
  const keptR = (filter: Partial<ListFilter>) => ALL.filter((r) => rowMatches(r, { ...NO_LIST_FILTER, ...filter }, NOW, undefined, undefined, isRoutine)).map((r) => r.thread_id);

  test('Routine threads keeps only routines\' threads; Other threads hides them; both are every row', () => {
    expect(keptR({ routines: ['routine'] })).toEqual(['billingToday', 'mixed']);
    expect(keptR({ routines: ['other'] })).toEqual(ALL.map((r) => r.thread_id).filter((id) => id !== 'billingToday' && id !== 'mixed'));
    expect(keptR({ routines: ['routine', 'other'] })).toEqual(ALL.map((r) => r.thread_id));
  });

  test('with another group they narrow each other, and a menu row counts with the other groups only', () => {
    expect(keptR({ routines: ['routine'], notSeen: true, projects: ['prj_ops'] })).toEqual(['mixed']);
    const filter: ListFilter = { ...NO_LIST_FILTER, routines: ['routine'], projects: ['prj_web'] };
    expect(countWhere(ALL, filter, NOW, 'routines', (r) => !isRoutine(r), undefined, isRoutine)).toBe(3);
    expect(countWhere(ALL, filter, NOW, 'projects', (r) => r.project.id === 'prj_ops', undefined, isRoutine)).toBe(1);
  });

  test('the sections the list draws keep only the matches', () => {
    const sections = [
      { id: 'waiting', label: 'Waiting on you', threads: [ROWS.billingToday, ROWS.webLateYesterday] },
      { id: 'quiet', label: 'Quiet', threads: [ROWS.mixed] },
    ] as InboxListSection[];
    const out = filterListSections(sections, { ...NO_LIST_FILTER, routines: ['other'] }, NOW, undefined, undefined, isRoutine);
    expect(out.map((s) => [s.id, s.threads.map((r) => r.thread_id)])).toEqual([
      ['waiting', ['webLateYesterday']],
      ['quiet', []],
    ]);
  });

  test('a linked computer\'s routine thread is a routine thread too (the merged read lists its routines)', () => {
    expect(isRoutine(ROWS.billingToday)).toBe(true);
    expect(isRoutine({ ...ROWS.billingToday, machine: OTHER } as InboxListRow)).toBe(true);
    expect(isRoutine({ ...ROWS.webLateYesterday, machine: OTHER } as InboxListRow)).toBe(false);
    expect(routineThreadTest(null)).toBeNull();
  });

  test('Routines off here and on a linked computer: the group still applies; off everywhere: it steps aside', () => {
    expect(routineThreadsState({ on: false, rows: [routine('mixed')], error: null, computers: [{ id: OTHER, on: true, launch_on: true, away: false }] })).toBe('ready');
    expect(routineThreadsState({ on: false, rows: null, error: null, computers: [{ id: OTHER, on: false, launch_on: true, away: false }] })).toBe('off');
  });

  test('a deleted routine leaves the routines list: its thread stays and counts as Other', () => {
    const afterDelete = routineThreadTest([routine('mixed')])!;
    expect(afterDelete(ROWS.billingToday)).toBe(false);
    expect(ALL.filter((r) => rowMatches(r, { ...NO_LIST_FILTER, routines: ['other'] }, NOW, undefined, undefined, afterDelete)).map((r) => r.thread_id)).toContain('billingToday');
  });

  test('three states: off (or a failed read) steps aside, not read yet waits, read applies; "not read" is never "no routine threads"', () => {
    const state = (on: boolean | null, rows: InboxScheduledRow[] | null, error: string | null = null) => routineThreadsState({ on, rows, error });
    expect(state(false, null)).toBe('off');
    expect(state(null, null)).toBe('pending');
    expect(state(true, null)).toBe('pending');
    expect(state(true, null, 'Could not read routines')).toBe('off');
    expect(state(true, [])).toBe('ready');
    // Only a saved Routine pick waits; with none, nothing is held.
    expect(routineHold({ state: 'pending' }, { routines: ['routine'] })).toBe(true);
    expect(routineHold({ state: 'pending' }, { routines: [] })).toBe(false);
    expect(routineHold({ state: 'off' }, { routines: ['routine'] })).toBe(false);
  });

  test('while Routines are off (or not read) the picks step aside: they neither filter nor count; on, they do', () => {
    const filter: ListFilter = { ...NO_LIST_FILTER, routines: ['routine'], agents: ['Pi'] };
    expect(appliedFilter(filter, false)).toEqual({ ...filter, routines: [] });
    expect(pickCount(appliedFilter(filter, false))).toBe(1);
    expect(appliedFilter(filter, false, false, true)).toBe(filter);
    expect(pickCount(appliedFilter(filter, false, false, true))).toBe(2);
    expect(clearedFrom(filter, false)).toEqual(NO_LIST_FILTER);
  });
});
